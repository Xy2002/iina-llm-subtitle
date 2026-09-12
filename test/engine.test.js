"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCacheKey } = require("../src/engine/cache.js");
const { createEngine } = require("../src/engine/index.js");

const SRT = "1\n00:00:01,000 --> 00:00:03,500\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue.";

/** In-memory storage port + counting fake transport, shared fixture. */
function makeRig(controls = {}) {
  /** @type {Map<string, any>} */
  const records = new Map();
  const requests = [];
  let transportCalls = 0;
  const storage = {
    /** @param {string} key @returns {Promise<any | null>} */
    get: async (key) => records.get(`variant:${key}`) || null,
    /** @param {string} key @param {any} record @returns {Promise<void>} */
    put: async (key, record) => {
      records.set(`variant:${key}`, record);
    },
    getState: async (key) => records.get(`state:${key}`) || null,
    putState: async (key, state) => {
      records.set(`state:${key}`, state);
    },
    clearState: async (key) => {
      records.delete(`state:${key}`);
    },
    getTranslations: async (key) => records.get(`translations:${key}`) || null,
    putTranslations: async (key, translations) => {
      records.set(`translations:${key}`, translations);
    },
  };
  const transport = {
    /** @param {{body: any}} _request @returns {Promise<{status: number, retryAfter: null, json: any}>} */
    postJson: async (_request) => {
      transportCalls += 1;
      const context = JSON.parse(_request.body.messages[1].content);
      requests.push(context);
      if (context.purpose === "glossary") return { status: 200, retryAfter: null, json: { glossary: [] } };
      const cues = context.cues;
      return { status: 200, retryAfter: null, json: { translations: cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) } };
    },
  };
  return {
    engine: createEngine({ storage, transport, glossaryPrecheck: false, ...controls }),
    records,
    requests,
    calls: () => transportCalls,
    state: (key) => records.get(`state:${key}`) || null,
  };
}

test("cache key is deterministic and changes with each of its user-facing elements", () => {
  const base = { model: "glm-4", targetLanguage: "zh-Hans" };
  const key = buildCacheKey("Hello.", base);
  assert.equal(key, buildCacheKey("Hello.", base));
  assert.notEqual(key, buildCacheKey("Hello!!", base), "content must matter");
  assert.notEqual(key, buildCacheKey("Hello.", { ...base, model: "other" }), "model must matter");
  assert.notEqual(key, buildCacheKey("Hello.", { ...base, targetLanguage: "en" }), "language must matter");
});

test("fresh run translates, stores both variants, and reports a miss", async () => {
  const rig = makeRig();
  const result = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  assert.equal(result.cacheHit, false);
  assert.match(result.cacheKey, /^[0-9a-f]{64}$/);
  assert.equal(result.bilingual.path, `cache-${result.cacheKey}.bilingual.ass`);
  assert.equal(result.translationOnly.path, `cache-${result.cacheKey}.translation-only.ass`);
  assert.match(result.bilingual.content, /Hello world\.\\N\{\\rTranslation\}\[译\] Hello world\./);
  assert.match(result.translationOnly.content, /\[译\] Hello world\./);
  assert.ok(!result.translationOnly.content.includes(",Original,cue-0,"), "translation-only variant must not carry original dialogues");
  assert.equal(rig.calls(), 1);
});

test("repeat run with the same input hits the cache and never calls the transport", async () => {
  const rig = makeRig();
  const first = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  const second = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.cacheKey, first.cacheKey);
  assert.equal(second.bilingual.content, first.bilingual.content);
  assert.equal(second.translationOnly.content, first.translationOnly.content);
  assert.equal(rig.calls(), 1);
});

test("changing model or target language misses the cache", async () => {
  const rig = makeRig();
  await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  const otherModel = await rig.engine.translateTrack(SRT, { model: "other", targetLanguage: "zh-Hans" });
  const otherLang = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "en" });
  assert.equal(otherModel.cacheHit, false);
  assert.equal(otherLang.cacheHit, false);
  assert.equal(rig.calls(), 3);
});

test("bad SRT input fails before any translation cost", async () => {
  const rig = makeRig();
  await assert.rejects(() => rig.engine.translateTrack("not an srt", { model: "m", targetLanguage: "zh-Hans" }), /Invalid SRT cue|No SRT cues/);
  assert.equal(rig.calls(), 0);
});

test("engine cancellation dependency stops requests and preserves resumable state", async () => {
  const rig = makeRig({ shouldCancel: () => true });
  const result = await rig.engine.translateTrack(SRT, { model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "cancelled");
  assert.equal(rig.calls(), 0, "cancelled work must not send paid requests");
  assert.equal(result.bilingual, undefined, "cancelled work must not assemble a track");
  assert.ok(rig.state(result.cacheKey), "a cancelled run retains resumable state");
});

test("re-saved BOM/CRLF variants hit the same cache entry", async () => {
  const rig = makeRig();
  const first = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  const resaved = await rig.engine.translateTrack("\uFEFF" + SRT.replace(/\n/g, "\r\n"), { model: "glm-4", targetLanguage: "zh-Hans" });
  assert.equal(resaved.cacheHit, true);
  assert.equal(resaved.cacheKey, first.cacheKey);
  assert.equal(rig.calls(), 1);
});

test("ASS-source cues keep inline tags on the original line, plain text to the transport", async () => {
  const rig = makeRig();
  const result = await rig.engine.translateTrack(
    { format: "ass", content: "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Styled{\\i0} ASS line.\n" },
    { model: "glm-4", targetLanguage: "zh-Hans" },
  );
  assert.match(
    result.bilingual.content,
    /\{\\i1\}Styled\{\\i0\} ASS line\.\\N\{\\rTranslation\}\[译\] Styled ASS line\./,
  );
  assert.equal(result.status, "completed");
});

test("ASS drawings render only in the bilingual variant and never reach the LLM", async () => {
  const rig = makeRig({ glossaryPrecheck: true });
  const drawing = "{\\p1}m 0 0 l 100 0 100 100 0 100";
  const subtitle = { format: "ass", content: `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,${drawing}\nDialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,${drawing}{\\p0}World\n` };
  const result = await rig.engine.translateTrack(subtitle, { model: "m", targetLanguage: "zh-Hans" });
  assert.equal(rig.requests.length, 2, "one glossary request and one translation request");
  for (const request of rig.requests) {
    assert.deepEqual(request.cues, [{ id: "t0", text: "Hello" }, { id: "t2", text: "World" }]);
  }
  const bilingualEvents = result.bilingual.content.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(bilingualEvents.length, 3, "keep the original drawing event");
  assert.ok(bilingualEvents[1].endsWith(drawing), "drawing-only events have no appended translation or line break");
  const translatedEvents = result.translationOnly.content.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(translatedEvents.length, 2);
  assert.ok(translatedEvents.every((line) => !line.includes("m 0 0")));
  assert.match(translatedEvents[1], /\[译\] World$/);
  const cached = await rig.engine.translateTrack(subtitle, { model: "m", targetLanguage: "zh-Hans" });
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.bilingual.content, result.bilingual.content);
  assert.equal(rig.requests.length, 2);
});

test("cache hit re-assembles with the current style without re-translation", async () => {
  const rig = makeRig();
  const first = await rig.engine.translateTrack(SRT, { model: "glm-4", targetLanguage: "zh-Hans" });
  const styled = await rig.engine.translateTrack(SRT, {
    model: "glm-4",
    targetLanguage: "zh-Hans",
    style: { translationColor: "#FF8800", fontSizeRatio: 0.7, lineOrder: "translationFirst" },
  });
  assert.equal(styled.cacheHit, true);
  assert.equal(rig.calls(), 1, "no re-translation for a style change");
  assert.notEqual(styled.bilingual.content, first.bilingual.content, "content re-assembled");
  assert.match(styled.bilingual.content, /Style: Translation,Arial,25,&H000088FF/);
  assert.match(styled.bilingual.content, /\[译\] Hello world\.\\N\{\\rOriginal\}Hello world\./);
  // The on-disk variant files were refreshed to the new style.
  assert.equal(rig.records.get(`variant:${styled.cacheKey}`).bilingual.content, styled.bilingual.content);
});
