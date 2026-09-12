"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { createBatchTranslator, planBatches } = require("../src/engine/translate.js");

/** @param {number} n @returns {any[]} */
function makeCues(n) {
  return Array.from({ length: n }, (_, i) => ({ ordinal: i, startMs: i * 2000, endMs: i * 2000 + 1500, text: `Line ${i}` }));
}

function okBody(cues, overrideText) {
  return {
    status: 200,
    retryAfter: null,
    json: { translations: cues.map((cue) => ({ id: `t${cue.ordinal.toString(36)}`, text: overrideText || `[译] ${cue.text}` })) },
  };
}

/** Scriptable transport: handlers tried in order per call; records everything. */
function scriptTransport(handlers, { latency = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    maxInFlight: () => maxInFlight,
    postJson: async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const index = calls.length;
      calls.push(request);
      try {
        if (latency) await new Promise((r) => setTimeout(r, latency));
        const handler = handlers[index] ?? handlers[handlers.length - 1];
        if (typeof handler === "function") return await handler(request, index);
        return handler;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

function makeRig({ transport, state = null, shouldCancel = () => false, maxBatchChars, glossaryPrecheck = false } = {}) {
  /** @type {Map<string, any>} */
  const variants = new Map();
  /** @type {any[]} */
  const stateSnapshots = [];
  const delays = [];
  /** @type {any} */
  let savedState = state;
  const deps = {
    transport,
    delay: async (ms) => delays.push(ms),
    random: () => 0.5,
    shouldCancel,
    maxBatchChars,
    glossaryPrecheck,
    storage: {
      get: async () => null,
      put: async (key, record) => {
        variants.set(key, record);
      },
      getState: async () => savedState,
      putState: async (key, s) => {
        savedState = s;
        stateSnapshots.push(s);
      },
      clearState: async () => {
        savedState = null;
      },
      getTranslations: async () => null,
      putTranslations: async () => {},
    },
  };
  return { deps, variants, delays, states: stateSnapshots, lastState: () => savedState };
}

function parseRequestCues(request) {
  const user = JSON.parse(request.body.messages[1].content);
  return user.cues;
}

/** Echo handler: responds with valid translations for whatever cues were sent. */
function echoOk(request) {
  const cues = parseRequestCues(request);
  return { status: 200, retryAfter: null, json: { translations: cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) } };
}

test("plans batches within the character budget without splitting cues", () => {
  const cues = makeCues(7).map((cue, i) => ({ ...cue, text: "x".repeat(i < 6 ? 2500 : 2500) }));
  const batches = planBatches(cues, { maxBatchChars: 6000 });
  assert.equal(batches.length, 4, "pairs of 2500-char cues, the last one alone");
  batches.forEach((batch) => {
    const chars = batch.reduce((sum, cue) => sum + cue.text.length, 0);
    assert.ok(chars <= 6000, `batch over budget: ${chars}`);
  });
  assert.deepEqual(batches.flat().length, 7, "no cue lost or duplicated");
});

test("an oversized cue gets its own batch", () => {
  const big = { ...makeCues(3)[2], text: "x".repeat(7000) };
  const batches = planBatches([makeCues(2)[0], makeCues(2)[1], big], { maxBatchChars: 6000 });
  assert.equal(batches.length, 2, "two small cues share a batch, the oversized one stands alone");
  assert.equal(batches[1][0].text.length, 7000, "oversized cue is never split");
});

test("happy path: batches translate concurrently-bounded, variants assemble, state clears", async () => {
  const transport = scriptTransport([echoOk, echoOk]);
  // two batches of 2 cues each
  const cues = makeCues(4);
  const events = [];
  const rig = makeRig({ transport, maxBatchChars: 15 });
  const engine = require("../src/engine/index.js").createEngine(rig.deps);
  const result = await engine.translateTrack(
    { format: "srt", content: cues.map((cue) => `${cue.ordinal + 1}\n00:00:0${cue.ordinal},000 --> 00:00:0${cue.ordinal + 1},000\n${cue.text}`).join("\n\n") },
    { model: "m", targetLanguage: "zh-Hans" },
    { onProgress: (event) => events.push(event) },
  );
  assert.equal(result.status, "completed");
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.maxInFlight() <= 2, "concurrency must not exceed 2");
  assert.deepEqual(
    events.filter((e) => e.phase === "translation").map((e) => `${e.done}/${e.total}`),
    ["0/2", "1/2", "2/2"],
  );
  assert.ok(events.some((e) => e.phase === "assembly"));
  assert.match(result.bilingual.content, /Line 0\\N\{\\rTranslation\}\[译\] Line 0/);
  assert.equal(rig.lastState(), null, "state cleared on completion");
});

test("wire ids are opaque per-ordinal tokens echoed exactly once in the response", async () => {
  const transport = scriptTransport([echoOk]);
  const rig = makeRig({ transport });
  await createBatchTranslator(rig.deps)(makeCues(3), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  const sent = parseRequestCues(transport.calls[0]);
  assert.deepEqual(sent.map((cue) => cue.id), ["t0", "t1", "t2"]);
});

test("corrupt JSON response is retried and a good follow-up completes", async () => {
  const cues = makeCues(2);
  const transport = scriptTransport([
    { status: 200, retryAfter: null, json: { translations: "not-an-array" } },
    okBody(cues),
  ]);
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  assert.equal(transport.calls.length, 2);
  assert.ok(rig.delays.length >= 1, "backoff delay applied before retry");
});

test("response missing a cue id fails validation and retries", async () => {
  const cues = makeCues(3);
  const partial = {
    status: 200, retryAfter: null,
    json: { translations: [{ id: "t0", text: "a" }, { id: "t1", text: "b" }] },
  };
  const transport = scriptTransport([partial, partial, okBody(cues)]);
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  assert.ok(transport.calls.length >= 3);
});

test("retries exhaust into a classified error with backoff rhythm", async () => {
  const transport = scriptTransport([() => { throw Object.assign(new Error("eof"), { code: "network" }); }]);
  const rig = makeRig({ transport });
  await assert.rejects(
    () => createBatchTranslator(rig.deps)(makeCues(2), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" }),
    (error) => error.classification === "network",
  );
  assert.equal(transport.calls.length, 4, "initial attempt + 3 retries");
  assert.deepEqual(rig.delays, [1000, 2000, 4000], "1/2/4s backoff, jitter 0.5 => exact base");
});

test("quota errors are not retried", async () => {
  const transport = scriptTransport([{ status: 402, retryAfter: null, json: { error: { message: "insufficient quota" } } }]);
  const rig = makeRig({ transport });
  await assert.rejects(
    () => createBatchTranslator(rig.deps)(makeCues(2), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" }),
    (error) => error.classification === "quota",
  );
  assert.equal(transport.calls.length, 1);
});

test("rate-limit responses honor Retry-After over the base backoff", async () => {
  const cues = makeCues(2);
  const transport = scriptTransport([
    { status: 429, retryAfter: 7, json: null },
    okBody(cues),
  ]);
  const rig = makeRig({ transport });
  await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.ok(rig.delays[0] >= 7000, `delay must respect Retry-After: ${rig.delays[0]}`);
});

test("repeated timeouts split the batch in half and both halves succeed", async () => {
  const cues = makeCues(4);
  const transport = scriptTransport([
    () => { throw Object.assign(new Error("t"), { code: "timeout" }); },
    () => { throw Object.assign(new Error("t"), { code: "timeout" }); },
    okBody(cues.slice(0, 2)),
    okBody(cues.slice(2)),
  ]);
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  const halves = transport.calls.slice(2).map((call) => parseRequestCues(call).map((cue) => cue.id).sort().join(","));
  halves.sort();
  assert.deepEqual(halves, ["t0,t1", "t2,t3"], "the split halves must cover the original batch");
});

test("helper HTTP 504 timeouts split the batch and retain every cue", async () => {
  const cues = makeCues(4);
  const transport = scriptTransport([
    { status: 504, retryAfter: null, json: { error: { type: "timeout", message: "upstream timeout" } } },
    { status: 504, retryAfter: null, json: { error: { type: "timeout", message: "upstream timeout" } } },
    echoOk,
  ]);
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  assert.deepEqual(transport.calls.map((request) => parseRequestCues(request).length), [4, 4, 2, 2]);
  assert.deepEqual(Object.keys(result.translationsById), ["t0", "t1", "t2", "t3"]);
});

test("concurrency never exceeds 2 with many batches", async () => {
  const cues = makeCues(12);
  const transport = scriptTransport([echoOk], { latency: 5 });
  const rig = makeRig({ transport, maxBatchChars: 10 });
  await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.ok(transport.maxInFlight() <= 2, `max in flight ${transport.maxInFlight()}`);
  assert.equal(transport.calls.length, 12);
});

test("cancel mid-run: completed batches persist, nothing assembles, status cancelled", async () => {
  const cues = makeCues(4);
  let done = 0;
  const rig = makeRig({
    transport: scriptTransport([echoOk], { latency: 1 }),
    shouldCancel: () => done >= 1,
    maxBatchChars: 15,
  });
  const result = await createBatchTranslator(rig.deps)(cues, {
    cacheKey: "k", model: "m", targetLanguage: "zh-Hans",
    onProgress: (event) => {
      if (event.phase === "translation" && event.done > 0) done += 1;
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(rig.variants.size, 0, "no variants assembled after cancel");
  assert.ok(rig.lastState(), "partial state persisted");
  const saved = rig.lastState().translations;
  assert.ok(Object.keys(saved).length > 0, "completed batches kept in state");
});

test("cancelling during backoff prevents another paid retry", async () => {
  let cancel = false;
  const transport = scriptTransport([() => { throw Object.assign(new Error("offline"), { code: "network" }); }]);
  const rig = makeRig({ transport, shouldCancel: () => cancel });
  rig.deps.delay = async () => { cancel = true; };
  const result = await createBatchTranslator(rig.deps)(makeCues(2), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "cancelled");
  assert.equal(result.completed, 0);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(rig.lastState().translations, {});
});

test("re-entry after cancel translates only the remaining cues", async () => {
  const cues = makeCues(4);
  const state = { version: 1, translations: { t0: "[译] L0", t1: "[译] L1" } };
  const transport = scriptTransport([echoOk]);
  const rig = makeRig({ transport, state });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  const requestedIds = transport.calls.flatMap((call) => parseRequestCues(call).map((cue) => cue.id));
  assert.ok(!requestedIds.includes("t0") && !requestedIds.includes("t1"), "already-translated cues not re-requested");
  assert.ok(requestedIds.includes("t2") && requestedIds.includes("t3"));
  assert.equal(result.translationsById.t0, "[译] L0");
  assert.equal(result.translationsById.t2, "[译] Line 2");
});

test("fatal error after completed batches persists their state", async () => {
  const cues = makeCues(4);
  const transport = scriptTransport([
    echoOk,
    { status: 402, retryAfter: null, json: { error: { message: "quota exhausted" } } },
  ]);
  const rig = makeRig({ transport, maxBatchChars: 15 });
  await assert.rejects(
    () => createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" }),
    (error) => error.classification === "quota",
  );
  const saved = rig.lastState();
  assert.ok(saved && Object.keys(saved.translations).length > 0, "completed batches survived the fatal error");
  assert.ok(Object.keys(saved.translations).length < 4, "and incomplete batches did not fake completion");
});

test("failure waits for dispatched batches to persist before allowing a resume", async () => {
  const cues = makeCues(4);
  let releaseFirst;
  const transport = scriptTransport([
    (request) => new Promise((resolve) => { releaseFirst = () => resolve(echoOk(request)); }),
    { status: 402, retryAfter: null, json: null },
  ]);
  const rig = makeRig({ transport, maxBatchChars: 15 });
  let settled = false;
  const run = createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  const observed = run.then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeFirstBatch = settled;
  releaseFirst();
  const error = await observed;
  assert.equal(settledBeforeFirstBatch, false, "returning early allows a new run to request the same pending cues");
  assert.equal(error.classification, "quota");
  assert.deepEqual(Object.keys(rig.lastState().translations), ["t0", "t1"]);

  const resumedTransport = scriptTransport([echoOk]);
  const resumed = makeRig({ transport: resumedTransport, state: JSON.parse(JSON.stringify(rig.lastState())), maxBatchChars: 15 });
  await createBatchTranslator(resumed.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.deepEqual(resumedTransport.calls.flatMap(parseRequestCues).map((cue) => cue.id), ["t2", "t3"]);
});

test("OpenAI-shaped responses with fenced JSON content are accepted", async () => {
  const transport = {
    calls: [],
    postJson: async (request) => {
      const cues = JSON.parse(request.body.messages[1].content).cues;
      const inner = JSON.stringify({ translations: cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) });
      return { status: 200, retryAfter: null, json: { choices: [{ message: { content: "```json\n" + inner + "\n```" } }] } };
    },
  };
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(makeCues(2), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
});

test("HTTP 408 is classified as a retryable timeout", async () => {
  const cues = makeCues(2);
  const transport = scriptTransport([
    { status: 408, retryAfter: null, json: null },
    okBody(cues),
  ]);
  const rig = makeRig({ transport });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  assert.equal(transport.calls.length, 2);
});

test("resume works when a whole batch is already done", async () => {
  const cues = makeCues(2);
  const state = { version: 1, translations: { t0: "x", t1: "y" } };
  const transport = scriptTransport([okBody([])]);
  const rig = makeRig({ transport, state });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  assert.equal(transport.calls.length, 0, "fully-done track needs no requests");
});
