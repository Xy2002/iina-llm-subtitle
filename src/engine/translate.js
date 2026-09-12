"use strict";

/**
 * The batch translation loop: plan cue batches by character budget, call the
 * OpenAI-compatible transport (via the loopback helper in production), accept
 * only strict id-checked JSON responses, retry transient failures with
 * jittered 1/2/4s backoff that honors Retry-After, split repeatedly-timed-out
 * batches in half, run at most 2 requests in flight, persist state after
 * every completed batch so an interrupted run resumes without re-paying, and
 * report progress for the sidebar UI.
 *
 * deps:
 * - transport: { postJson({path, body}) -> Promise<{status, retryAfter?, json}> }
 *   HTTP boundary; errors carry code "timeout" | "network".
 * - storage: variant record ops (see index.js) plus getState/putState/clearState
 *   for the resumable partial state.
 * - delay(ms): clock port for backoff. random(): [0,1) for jitter.
 */

const DEFAULT_MAX_BATCH_CHARS = 6000;
const CONCURRENCY = 2;
const TIMEOUTS_BEFORE_SPLIT = 2;
const BACKOFF_BASES = [1000, 2000, 4000];

/** @typedef {Error & {code?: string, classification?: string, split?: boolean}} TransportError */

/** @param {number} ordinal @returns {string} */
function wireId(ordinal) {
  return `t${ordinal.toString(36)}`;
}

/**
 * Greedy consecutive fill: never split a cue, never exceed the budget, an
 * oversized cue gets its own batch.
 * @param {Array<{text: string}>} cues
 * @param {{maxBatchChars?: number}} [options]
 */
function planBatches(cues, options) {
  const maxBatchChars = (options && options.maxBatchChars) || DEFAULT_MAX_BATCH_CHARS;
  /** @type {any[][]} */
  const batches = [];
  /** @type {any[]} */
  let current = [];
  let chars = 0;
  for (const cue of cues) {
    if (current.length > 0 && chars + cue.text.length > maxBatchChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(cue);
    chars += cue.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** @param {number} status @returns {string} */
function classifyStatus(status) {
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate";
  if (status === 401 || status === 402 || status === 403) return "quota";
  if (status >= 500) return "server";
  return "request";
}

/** @param {number} attempt @param {number | null | undefined} retryAfterSeconds @param {() => number} random @returns {number} */
function backoffMilliseconds(attempt, retryAfterSeconds, random) {
  const base = BACKOFF_BASES[Math.min(attempt - 1, BACKOFF_BASES.length - 1)];
  const jittered = base * (0.75 + random() * 0.5);
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.max(jittered, retryAfterSeconds * 1000);
  return jittered;
}

/** @param {string} content @returns {any} */
function parseLooseJson(content) {
  const unfenced = String(content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

/** @param {string} message @returns {TransportError} */
function parseError(message) {
  return Object.assign(new Error(message), { code: "parse" });
}

/**
 * Validate the response: every sent id exactly once, non-empty text. Throws a
 * retryable "parse" error on any deviation.
 * @param {any[]} batchCues @param {any} json @returns {Map<string, string>}
 */
function validatedTranslations(batchCues, json) {
  let payload = json;
  // Real OpenAI-compatible responses wrap the content as a string inside
  // choices[0].message.content, possibly with markdown fences.
  const content = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : null;
  if (typeof content === "string") payload = parseLooseJson(content);
  const list = payload && Array.isArray(payload.translations) ? payload.translations : null;
  if (!list) {
    throw parseError("Response JSON is missing a translations array.");
  }
  /** @type {Map<string, string>} */
  const byId = new Map();
  for (const item of list) {
    if (!item || typeof item.id !== "string" || typeof item.text !== "string" || !item.text.trim()) {
      throw parseError("Response translation entry is malformed.");
    }
    if (byId.has(item.id)) {
      throw parseError(`Response has duplicate id ${item.id}.`);
    }
    byId.set(item.id, item.text);
  }
  for (const cue of batchCues) {
    const id = wireId(cue.ordinal);
    if (!byId.has(id)) {
      throw parseError(`Response is missing id ${id}.`);
    }
  }
  if (byId.size !== batchCues.length) {
    throw parseError("Response contains unknown ids.");
  }
  return byId;
}

/** @param {string} targetLanguage @returns {string} */
function systemPrompt(targetLanguage) {
  return [
    `You are a professional subtitle translator. Translate each subtitle line into ${targetLanguage}.`,
    "Preserve meaning, tone and register. Keep proper nouns consistent: when the request provides a glossary, use its translations exactly.",
    "Never add explanations, notes or quotes of your own.",
    'Reply with a single JSON object of shape {"translations":[{"id":"<id from the input>","text":"<translated line>"}]}.',
    "Include every input id exactly once. Never merge or split lines; if a line is already in the target language, return it unchanged.",
  ].join(" ");
}

/** @param {string} targetLanguage @returns {string} */
function glossaryPrompt(targetLanguage) {
  return [
    "You are preparing a translation glossary for a subtitle track.",
    `From the subtitle lines, identify proper nouns and recurring significant terms: character names, place names, organizations, titles.`,
    `For each, give its natural translation into ${targetLanguage}.`,
    'Reply with a single JSON object of shape {"glossary":[{"source":"<original term>","target":"<translation>"}]}.',
    "Only real proper nouns or recurring significant terms belong in the glossary; return an empty list if there are none.",
  ].join(" ");
}

/** @param {any} json @returns {Array<{source: string, target: string}>} */
function validatedGlossary(json) {
  const payload = json && json.choices && json.choices[0] && json.choices[0].message ? parseLooseJson(json.choices[0].message.content) : json;
  const list = payload && Array.isArray(payload.glossary) ? payload.glossary : [];
  /** @type {Array<{source: string, target: string}>} */
  const entries = [];
  for (const item of list) {
    if (item && typeof item.source === "string" && item.source.trim() && typeof item.target === "string" && item.target.trim()) {
      entries.push({ source: item.source, target: item.target });
    }
  }
  return entries;
}

/**
 * @param {{
 *   transport: { postJson(request: {path: string, body: any}): Promise<{status: number, retryAfter?: number | null, json: any}> },
 *   storage: { getState(key: string): Promise<any | null>, putState(key: string, state: any): Promise<void>, clearState(key: string): Promise<void> },
 *   delay: (ms: number) => Promise<void>,
 *   random: () => number,
 *   shouldCancel?: () => boolean,
 *   maxBatchChars?: number,
 *   glossaryPrecheck?: boolean,
 *   precedingWindow?: number,
 *   maxRetries?: number,
 * }} deps
 */
function createBatchTranslator(deps) {
  /**
   * Translate a full cue set. Resumes from persisted state; returns
   * {status: "completed"} or {status: "cancelled"}.
   */
  /**
   * @param {Array<{ordinal: number, text: string}>} cues
   * @param {{cacheKey: string, model: string, targetLanguage: string, onProgress?: (event: any) => void, shouldCancel?: () => boolean}} options
   * @returns {Promise<{status: "cancelled", completed: number, total: number} | {status: "completed", completed: number, total: number, translationsById: Record<string, string>}>}
   */
  return async function run(cues, options) {
    const { cacheKey, model, targetLanguage, onProgress } = options;
    const shouldCancel = options.shouldCancel || deps.shouldCancel || (() => false);
    const saved = await deps.storage.getState(cacheKey);
    const state = saved && saved.version === 1 && saved.translations ? saved : { version: 1, translations: {} };

    const pending = cues.filter((cue) => !(wireId(cue.ordinal) in state.translations));
    const batches = planBatches(pending, { maxBatchChars: deps.maxBatchChars });
    const total = batches.length;
    let completed = 0;
    if (onProgress) onProgress({ phase: "translation", done: 0, total });

    let cancelled = false;
    const countTranslated = () => cues.filter((cue) => typeof state.translations[wireId(cue.ordinal)] === "string").length;

    // Glossary pre-check: one pass over the pending cues; a persisted
    // glossary (from an interrupted run) is reused; any failure degrades to
    // an empty glossary without blocking the run.
    let glossary = state.glossary && typeof state.glossary === "object" ? state.glossary : null;
    if (pending.length > 0 && !glossary && deps.glossaryPrecheck !== false) {
      try {
        glossary = await runGlossaryPrecheck(pending, { model, targetLanguage });
        state.glossary = glossary;
        await deps.storage.putState(cacheKey, state);
      } catch {
        glossary = null;
      }
    }
    const glossaryEntries = glossary
      ? Object.entries(glossary).map(([source, target]) => ({ source, target }))
      : [];
    /** Settled pairs closest to a batch's start, newest first (rolling window). */
    /** @param {number} firstOrdinal @returns {Array<{text: string, translation: string}>} */
    function precedingPairs(firstOrdinal) {
      const window = typeof deps.precedingWindow === "number" ? deps.precedingWindow : 5;
      return cues
        .filter((cue) => cue.ordinal < firstOrdinal && typeof state.translations[wireId(cue.ordinal)] === "string")
        .sort((a, b) => b.ordinal - a.ordinal)
        .slice(0, window)
        .map((cue) => ({ text: cue.text, translation: state.translations[wireId(cue.ordinal)] }));
    }

    /** @param {Array<{ordinal: number, text: string}>} batchCues @param {{model: string, targetLanguage: string}} opts @returns {Promise<Record<string, string>>} */
    async function runGlossaryPrecheck(batchCues, opts) {
      const { model: m, targetLanguage: lang } = opts;
      const batches = planBatches(batchCues, { maxBatchChars: deps.maxBatchChars });
      /** @type {Record<string, string>} */
      const merged = {};
      for (const part of batches) {
        if (shouldCancel()) throw new Error("cancelled during glossary pre-check");
        const body = {
          model: m,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: glossaryPrompt(lang) },
            { role: "user", content: JSON.stringify({ purpose: "glossary", target_language: lang, cues: part.map((cue) => ({ id: wireId(cue.ordinal), text: cue.text })) }) },
          ],
        };
        const { status, json } = await deps.transport.postJson({ path: "/chat/completions", body });
        if (status !== 200) throw new Error(`glossary pre-check failed: HTTP ${status}`);
        for (const entry of validatedGlossary(json)) merged[entry.source] = entry.target;
      }
      return merged;
    }

    /** @param {Array<{ordinal: number, text: string}>} batch @returns {Promise<boolean>} */
    async function runBatch(batch) {
      const requestCues = batch.map((cue) => ({ id: wireId(cue.ordinal), text: cue.text }));
      const body = {
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt(targetLanguage) },
          { role: "user", content: JSON.stringify({
              purpose: "translate",
              target_language: targetLanguage,
              glossary: glossaryEntries,
              preceding: precedingPairs(batch[0].ordinal),
              cues: requestCues,
            }) },
        ],
      };
      const maxRetries = typeof deps.maxRetries === "number" ? deps.maxRetries : 3;
      let attempt = 0;
      let timeouts = 0;
      for (;;) {
        if (cancelled || shouldCancel()) {
          cancelled = true;
          return false;
        }
        attempt += 1;
        /** @type {{status: number, retryAfter?: number | null, json: any, transportError?: TransportError}} */
        let response;
        try {
          response = await deps.transport.postJson({ path: "/chat/completions", body });
        } catch (error) {
          response = { status: 0, retryAfter: null, json: null, transportError: /** @type {TransportError} */ (error) };
        }

        if (!response.transportError && response.status === 200) {
          /** @type {Map<string, string>} */
          let byId;
          try {
            byId = validatedTranslations(batch, response.json);
          } catch (error) {
            if (attempt > maxRetries) throw Object.assign(/** @type {TransportError} */ (error), { classification: "parse" });
            await deps.delay(backoffMilliseconds(attempt, null, deps.random));
            continue;
          }
          for (const cue of batch) state.translations[wireId(cue.ordinal)] = byId.get(wireId(cue.ordinal));
          return true;
        }

        const code = response.transportError ? (response.transportError.code || "network") : classifyStatus(response.status);
        if (code === "timeout") timeouts += 1;

        const retryable = code !== "quota" && code !== "request";
        if (!retryable) {
          throw Object.assign(new Error(`LLM request failed (${code}): ${response.transportError ? response.transportError.message : `HTTP ${response.status}`}`), { classification: code });
        }
        if (code === "timeout" && timeouts >= TIMEOUTS_BEFORE_SPLIT && batch.length > 1) {
          throw Object.assign(new Error("batch timed out repeatedly"), { split: true });
        }
        if (attempt > maxRetries) {
          throw Object.assign(
            new Error(`LLM request failed after ${attempt} attempts (${code}).`),
            { classification: code === "parse" ? "parse" : code, transportError: response.transportError },
          );
        }
        await deps.delay(backoffMilliseconds(attempt, response.retryAfter, deps.random));
      }
    }

    /** @type {{batch: any[]}[]} */
    const queue = batches.map((batch) => ({ batch }));
    let cursor = 0;
    async function worker() {
      while (!cancelled) {
        if (shouldCancel()) {
          cancelled = true;
          return;
        }
        if (cursor >= queue.length) return;
        const item = queue[cursor];
        cursor += 1;
        try {
          if (!await runBatch(item.batch)) return;
        } catch (error) {
          const splitSignal = /** @type {TransportError} */ (error);
          if (splitSignal && splitSignal.split) {
            const half = Math.ceil(item.batch.length / 2);
            queue.splice(cursor, 0, { batch: item.batch.slice(0, half) }, { batch: item.batch.slice(half) });
            continue;
          }
          cancelled = true; // stop the sibling worker before failing the run
          throw error;
        }
        const done = ++completed;
        // Persist after every completed batch: a crash or fatal error on a
        // later batch must not discard the work already paid for.
        await deps.storage.putState(cacheKey, state);
        if (onProgress) onProgress({ phase: "translation", done, total, linesDone: countTranslated(), linesTotal: cues.length });
      }
    }
    // A failed request must not return control while another worker can
    // still persist state. Otherwise a resumed run races that old writer.
    const outcomes = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
      try {
        await worker();
      } catch (error) {
        cancelled = true;
        throw error;
      }
    }));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }

    if (cancelled) {
      await deps.storage.putState(cacheKey, state);
      return { status: "cancelled", completed, total };
    }

    if (onProgress) onProgress({ phase: "assembly", done: total, total });
    return { status: "completed", completed, total, translationsById: state.translations };
  };
}

module.exports = { createBatchTranslator, planBatches, wireId };
