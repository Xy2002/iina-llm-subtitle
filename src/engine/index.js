"use strict";

const { parseSrt } = require("./srt.js");
const { parseAss } = require("./ass.js");
const { buildBilingualAss, buildTranslationOnlyAss } = require("./assemble.js");
const { buildCacheKey, PIPELINE_VERSION } = require("./cache.js");
const { createBatchTranslator, planBatches, wireId } = require("./translate.js");

/**
 * Translation engine. Pure JavaScript with injected ports so the same code
 * runs in Node (tests) and IINA's JavaScriptCore:
 *
 * - storage: { get(key) -> Promise<record | null>, put(key, record) -> Promise<void> }
 *   Persistence for translated variants; the host maps it onto @data.
 *   A record is { bilingual: {path, content}, translationOnly: {path, content} }.
 * - translator: { translate(cues, context) -> Promise<string[]> }
 *   The LLM boundary; later tickets replace the fake with batching, retry,
 *   and the glossary pre-pass behind this same seam.
 *
 * Ports still to come: process (ffprobe/ffmpeg extraction, MAR-94) and
 * clock (retry backoff timing, MAR-95).
 */

/**
 * The single source of the cache file naming scheme; hosts prefix their own
 * storage root (e.g. @data/) onto these relative paths. Names stay flat —
 * IINA's file.write does not create intermediate directories.
 * @param {string} key
 * @returns {{bilingual: string, translationOnly: string}}
 */
function variantPaths(key) {
  return {
    bilingual: `cache-${key}.bilingual.ass`,
    translationOnly: `cache-${key}.translation-only.ass`,
  };
}

/**
 * A canonical cue serialization: identical cues produce identical bytes no
 * matter how the source SRT was encoded or line-wrapped, so re-saved files
 * keep hitting the cache.
 * @param {Cue[]} cues
 * @returns {string}
 */
function canonicalCueText(cues) {
  return cues
    .map((cue) => `${cue.startMs}\u0000${cue.endMs}\u0000${cue.text}`)
    .join("\u0001");
}

/**
 * @typedef {{
 *   ordinal: number,
 *   startMs: number,
 *   endMs: number,
 *   text: string,
 *   rawText?: string,
 *   isAssNative?: boolean,
 *   isDrawingOnly?: boolean,
 * }} Cue
 */

/**
 * @param {"srt" | "ass"} format
 * @param {string} content
 * @returns {Cue[]}
 */
function parseSubtitle(format, content) {
  if (format === "ass") return parseAss(content);
  if (format === "srt") return parseSrt(content);
  throw new Error(`Unsupported subtitle format: ${format}`);
}

/**
 * @typedef {{
 *   storage: {
 *     get(key: string): Promise<any | null>,
 *     put(key: string, record: any): Promise<void>,
 *     getState(key: string): Promise<any | null>,
 *     putState(key: string, state: any): Promise<void>,
 *     clearState(key: string): Promise<void>,
 *     getTranslations(key: string): Promise<string[] | null>,
 *     putTranslations(key: string, translations: string[]): Promise<void>,
 *   },
 *   transport: { postJson(request: {path: string, body: any}): Promise<{status: number, retryAfter?: number | null, json: any}> },
 *   delay?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   maxBatchChars?: number,
 *   glossaryPrecheck?: boolean,
 *   precedingWindow?: number,
 *   maxRetries?: number,
 *   shouldCancel?: () => boolean,
 * }} EngineDeps
 */

/**
 * @param {EngineDeps} deps
 */
function createEngine(deps) {
  const runBatch = createBatchTranslator({
    transport: deps.transport,
    storage: deps.storage,
    delay: deps.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    random: deps.random || Math.random,
    maxBatchChars: deps.maxBatchChars,
    glossaryPrecheck: deps.glossaryPrecheck,
    precedingWindow: deps.precedingWindow,
    maxRetries: deps.maxRetries,
    shouldCancel: deps.shouldCancel,
  });

  /**
   * Accepts either plain SRT text or a {format: "srt"|"ass", content} object.
   * @param {string | {format: "srt" | "ass", content: string}} subtitle
   * @param {{model: string, targetLanguage: string, style?: import("./assemble.js").AssemblyStyle}} options
   * @param {{onProgress?: (event: any) => void, shouldCancel?: () => boolean}} [controls]
   * @returns {Promise<{cacheHit: boolean, status?: string, cacheKey: string, bilingual?: {path: string, content: string}, translationOnly?: {path: string, content: string}, completed?: number, total?: number}>}
   */
  async function translateTrack(subtitle, options, controls) {
    /** @type {string | {format: "srt" | "ass", content: string}} */
    const input = typeof subtitle === "string" ? { format: /** @type {const} */ ("srt"), content: subtitle } : subtitle;
    // Parse before the cache lookup: invalid input always fails, and the
    // key is built from normalized cues so BOM/CRLF re-saves still hit.
    const cues = parseSubtitle(input.format, input.content);
    const cacheKey = buildCacheKey(canonicalCueText(cues), {
      model: options.model,
      targetLanguage: options.targetLanguage,
    });
    const storedTranslations = await deps.storage.getTranslations(cacheKey);
    if (storedTranslations) {
      // Cache hit: re-assemble with the current style so style changes apply
      // without re-translation, and refresh the variant files on disk.
      const paths = variantPaths(cacheKey);
      const refreshed = {
        bilingual: { path: paths.bilingual, content: buildBilingualAss(cues, storedTranslations, options.style) },
        translationOnly: { path: paths.translationOnly, content: buildTranslationOnlyAss(cues, storedTranslations, options.style) },
      };
      await deps.storage.put(cacheKey, refreshed);
      return { cacheHit: true, status: "completed", cacheKey, bilingual: refreshed.bilingual, translationOnly: refreshed.translationOnly };
    }
    const run = await runBatch(cues.filter((cue) => !cue.isDrawingOnly), {
      cacheKey,
      model: options.model,
      targetLanguage: options.targetLanguage,
      onProgress: controls && controls.onProgress,
      shouldCancel: controls && controls.shouldCancel,
    });
    if (run.status === "cancelled") {
      return { cacheHit: false, status: "cancelled", cacheKey, completed: run.completed, total: run.total };
    }
    // Keep the cache array aligned with all original events, including
    // drawings that have no text to send to the translator.
    const translations = cues.map((cue) => cue.isDrawingOnly ? "" : run.translationsById[wireId(cue.ordinal)]);
    if (translations.some((text) => typeof text !== "string")) {
      throw new Error("Translation state is incomplete despite a completed run.");
    }
    const paths = variantPaths(cacheKey);
    const record = {
      bilingual: { path: paths.bilingual, content: buildBilingualAss(cues, translations, options.style) },
      translationOnly: { path: paths.translationOnly, content: buildTranslationOnlyAss(cues, translations, options.style) },
    };
    await deps.storage.put(cacheKey, record);
    await deps.storage.putTranslations(cacheKey, translations);
    await deps.storage.clearState(cacheKey);
    return { cacheHit: false, status: "completed", cacheKey, bilingual: record.bilingual, translationOnly: record.translationOnly };
  }

  return { translateTrack };
}

/**
 * Cost estimate for the track picker: cue count, character count, planned
 * translation batches, and total request count. The glossary pre-check walks
 * the same cues under the same batch budget, so it costs the same number of
 * requests again.
 * @param {string | {format: "srt" | "ass", content: string}} subtitle
 * @param {{maxBatchChars?: number}} [options]
 * @returns {{cueCount: number, charCount: number, translationBatches: number, estimatedRequests: number}}
 */
function estimateTrack(subtitle, options) {
  /** @type {string | {format: "srt" | "ass", content: string}} */
  const input = typeof subtitle === "string" ? { format: /** @type {const} */ ("srt"), content: subtitle } : subtitle;
  const cues = parseSubtitle(input.format, input.content).filter((cue) => !cue.isDrawingOnly);
  const batches = planBatches(cues, options);
  const charCount = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  return {
    cueCount: cues.length,
    charCount,
    translationBatches: batches.length,
    estimatedRequests: batches.length * 2,
  };
}

module.exports = { createEngine, variantPaths, parseSubtitle, estimateTrack, PIPELINE_VERSION };
