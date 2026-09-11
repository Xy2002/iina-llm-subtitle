"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { createBatchTranslator, planBatches } = require("../src/engine/translate.js");
const { estimateTrack } = require("../src/engine/index.js");

const SRT = "1\n00:00:01,000 --> 00:00:03,500\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue.";

/** @param {number} n @returns {any[]} */
function makeCues(n) {
  return Array.from({ length: n }, (_, i) => ({ ordinal: i, startMs: i * 2000, endMs: i * 2000 + 1500, text: `Line ${i}` }));
}

function okBody(cues) {
  return { status: 200, retryAfter: null, json: { translations: cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) } };
}

function echoOk(request) {
  return okBody(parseRequestCues(request));
}

function parseRequestCues(request) {
  return JSON.parse(request.body.messages[1].content).cues;
}

function requestContext(request) {
  return JSON.parse(request.body.messages[1].content);
}

function scriptTransport(handlers) {
  const calls = [];
  return {
    calls,
    postJson: async (request) => {
      const index = calls.length;
      calls.push(request);
      const handler = handlers[index] ?? handlers[handlers.length - 1];
      if (typeof handler === "function") return await handler(request, index);
      return handler;
    },
  };
}

function makeRig({ transport, state = null, shouldCancel = () => false, maxBatchChars, glossaryPrecheck, precedingWindow } = {}) {
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
    precedingWindow,
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
    },
  };
  return { deps, variants, delays, states: stateSnapshots, lastState: () => savedState };
}

function glossaryOk(request) {
  // A glossary pre-check request: respond with a deterministic glossary.
  const context = requestContext(request);
  return {
    status: 200,
    retryAfter: null,
    json: { glossary: [{ source: "Alice", target: "爱丽丝" }] },
  };
}

test("glossary pre-check runs before batches and its result rides every batch request", async () => {
  const cues = [...makeCues(2), { ...makeCues(3)[2], text: "Alice waved." }];
  const transport = scriptTransport([
    glossaryOk,
    echoOk,
    echoOk,
  ]);
  const rig = makeRig({ transport, maxBatchChars: 600, glossaryPrecheck: true });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  // call 0 = glossary pre-check (single batch), calls 1..2 = the two translation batches
  const glossaryRequestsContext = requestContext(transport.calls[0]);
  assert.ok(glossaryRequestsContext.cues.some((cue) => cue.text.includes("Alice")), "pre-check sees the cue texts");
  for (const call of transport.calls.slice(1)) {
    const context = requestContext(call);
    assert.deepEqual(context.glossary, [{ source: "Alice", target: "爱丽丝" }]);
  }
});

test("glossary keeps the name consistent across the first and last batches", async () => {
  const cues = [
    { ordinal: 0, startMs: 0, endMs: 1500, text: "Alice said hi." },
    { ordinal: 1, startMs: 2000, endMs: 3500, text: "Alice waved." },
  ];
  // Fake model: glossary requests get the glossary; translation requests
  // substitute per whatever glossary the request carries.
  const transport = scriptTransport([
    (request) => {
      const context = requestContext(request);
      if (context.purpose === "glossary") return glossaryOk(request);
      const glossary = new Map((context.glossary || []).map((entry) => [entry.source, entry.target]));
      return okBody(context.cues.map((cue) => ({
        id: cue.id,
        text: cue.text.replace(/Alice/g, glossary.get("Alice") || "Alice"),
      })));
    },
  ]);
  const rig = makeRig({ transport, maxBatchChars: 12, glossaryPrecheck: true });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.translationsById.t0, "[译] 爱丽丝 said hi.");
  assert.equal(result.translationsById.t1, "[译] 爱丽丝 waved.", "same name in the last batch");
});

test("rolling window carries the previous N settled pairs into the next batch", async () => {
  const cues = makeCues(6);
  const transport = scriptTransport([
    glossaryOk,
    echoOk,
    echoOk,
    echoOk,
  ]);
  const rig = makeRig({ transport, maxBatchChars: 12, glossaryPrecheck: true, precedingWindow: 2 });
  await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  // Pre-check batches and translation batches are told apart by purpose.
  const translateCalls = transport.calls.map(requestContext).filter((context) => context.purpose === "translate");
  assert.equal(translateCalls.length, 3, "three paired translation batches");
  // With concurrency 2, adjacent batches overlap, so a batch's window is
  // best-effort: whatever pairs were settled when it dispatched. The final
  // batch (t4,t5) always dispatches after t0..t3 settled, so its window is
  // deterministic: the two most recent settled ordinals, newest first.
  const batchFor45 = requestContext(transport.calls.find((call) => {
    const context = requestContext(call);
    return context.purpose === "translate" && context.cues.map((cue) => cue.id).join() === "t4,t5";
  }));
  assert.deepEqual(batchFor45.preceding, [
    { text: "Line 3", translation: "[译] Line 3" },
    { text: "Line 2", translation: "[译] Line 2" },
  ]);
});

test("estimate: request count matches an actual run plus one pre-check", async () => {
  const estimate = estimateTrack(SRT, { maxBatchChars: 15 });
  assert.equal(estimate.cueCount, 2);
  assert.ok(estimate.charCount > 0);
  assert.equal(estimate.translationBatches, 2, "23 chars against a 15-char budget");
  assert.equal(estimate.estimatedRequests, 4, "pre-check walks the same batches, so requests double");

  // A real run with the same shape makes exactly that many calls.
  const transport = scriptTransport([glossaryOk, glossaryOk, echoOk, echoOk]);
  const rig = makeRig({ transport, maxBatchChars: 15, glossaryPrecheck: true });
  await createBatchTranslator(rig.deps)(require("../src/engine/srt.js").parseSrt(SRT), { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(transport.calls.length, estimate.estimatedRequests);
});

test("pre-check failure degrades to a glossary-less run without blocking", async () => {
  const cues = makeCues(2);
  const transport = scriptTransport([
    () => { throw Object.assign(new Error("boom"), { code: "network" }); },
    echoOk,
  ]);
  const rig = makeRig({ transport, glossaryPrecheck: true });
  const result = await createBatchTranslator(rig.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(result.status, "completed");
  const context = requestContext(transport.calls[1]);
  assert.deepEqual(context.glossary, [], "run continues with an empty glossary");
});

test("glossary survives a cancel/resume cycle via persisted state", async () => {
  const cues = makeCues(4);
  let done = 0;
  const transport = scriptTransport([glossaryOk, echoOk, echoOk, echoOk, echoOk]);
  const rig = makeRig({
    transport, maxBatchChars: 15, glossaryPrecheck: true, precedingWindow: 2,
    shouldCancel: () => done >= 1,
  });
  const first = await createBatchTranslator(rig.deps)(cues, {
    cacheKey: "k", model: "m", targetLanguage: "zh-Hans",
    onProgress: (event) => {
      if (event.phase === "translation" && event.done > 0) done += 1;
    },
  });
  assert.equal(first.status, "cancelled");
  const saved = rig.lastState();
  assert.ok(saved.glossary && saved.glossary.Alice === "爱丽丝", "glossary persisted with the partial state");

  // Re-entry: no second pre-check call — the glossary comes from state.
  const callsBefore = transport.calls.length;
  const resume = makeRig({ transport, state: saved, maxBatchChars: 15, glossaryPrecheck: true, precedingWindow: 2 });
  const final = await createBatchTranslator(resume.deps)(cues, { cacheKey: "k", model: "m", targetLanguage: "zh-Hans" });
  assert.equal(final.status, "completed");
  const glossaryCallsAfterResume = transport.calls.slice(callsBefore).filter((call) => requestContext(call).purpose === "glossary");
  assert.equal(glossaryCallsAfterResume.length, 0, "glossary reused from persisted state, no second pre-check");
  const finalTranslateContext = requestContext(transport.calls.at(-1));
  assert.deepEqual(finalTranslateContext.glossary, [{ source: "Alice", target: "爱丽丝" }], "persisted glossary still rides batch requests");
});

test("estimate handles ASS input and oversized cues", () => {
  const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Styled{\\i0} line.\n";
  const estimate = estimateTrack({ format: "ass", content: ass }, { maxBatchChars: 6000 });
  assert.equal(estimate.cueCount, 1);
  assert.ok(estimate.charCount <= 6000);
  assert.equal(estimate.translationBatches, 1);
});
