"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIinaPlugin, deferred, SOURCE_PATH, MEDIA_PATH } = require("./helpers/iina-plugin.js");

const TRANSLATE = "翻译字幕（当前轨）";
const translated = (context) => ({ status: 200, json: { translations: context.cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) } });
const translationRequests = (rig) => rig.requests.filter((request) => request.purpose === "translate");

test("missing configuration releases the run lock so the user can configure and retry", async () => {
  const rig = await loadIinaPlugin({ preferences: { baseUrl: "", model: "" } });
  await rig.click(TRANSLATE);
  assert.equal(rig.helperMessages.length, 0);
  assert.equal(rig.loads.length, 0);
  rig.prefs.set("baseUrl", "https://llm.invalid");
  rig.prefs.set("model", "test-model");
  await rig.click(TRANSLATE);
  assert.equal(translationRequests(rig).length, 1);
  assert.equal(rig.loads.length, 1);
});

test("repeated translate clicks cannot clear the active run lock", async () => {
  const pending = deferred();
  const rig = await loadIinaPlugin({ translate: () => pending.promise });
  await rig.click(TRANSLATE);
  await rig.click(TRANSLATE);
  await rig.click(TRANSLATE);
  assert.equal(translationRequests(rig).length, 1);
  assert.equal(rig.loads.length, 0);
  pending.resolve(translated(translationRequests(rig)[0]));
  await rig.advance();
  assert.equal(rig.loads.length, 1);
});

test("a source-read failure can be retried after the file becomes readable", async () => {
  const rig = await loadIinaPlugin();
  rig.readErrors.add(SOURCE_PATH);
  await rig.click(TRANSLATE);
  assert.equal(rig.helperMessages.length, 0);
  assert.equal(rig.loads.length, 0);
  assert.equal(rig.sidebarMessages.at(-1).data.view, "error");
  rig.readErrors.delete(SOURCE_PATH);
  await rig.click(TRANSLATE);
  assert.equal(translationRequests(rig).length, 1);
  assert.equal(rig.loads.length, 1);
});

test("cancellation keeps completed work without assembling or loading, then resume uses it", async () => {
  const pending = deferred();
  const rig = await loadIinaPlugin({ translate: () => pending.promise });
  await rig.click(TRANSLATE);
  await rig.sidebar("cancel");
  pending.resolve(translated(translationRequests(rig)[0]));
  await rig.advance();
  assert.equal(rig.loads.length, 0);
  assert.equal([...rig.files.keys()].some((filename) => filename.endsWith(".bilingual.ass")), false);
  assert.equal(rig.sidebarMessages.at(-1).data.cancelled, true);
  await rig.sidebar("resume");
  assert.equal(translationRequests(rig).length, 1, "the completed batch is reused after cancellation");
  assert.equal(rig.loads.length, 1);
});

test("a completed result from an old video never loads into the next video", async () => {
  const pending = deferred();
  let invoked = 0;
  const rig = await loadIinaPlugin({ createEngine: (deps) => ({ translateTrack: async () => {
    invoked++;
    await pending.promise;
    const record = { bilingual: { path: "cache-old.bilingual.ass", content: "old bilingual" },
      translationOnly: { path: "cache-old.translation-only.ass", content: "old translation" } };
    await deps.storage.put("old", record);
    return { status: "completed", cacheHit: false, cacheKey: "old", ...record };
  } }) });
  await rig.click(TRANSLATE);
  assert.equal(invoked, 1);
  await rig.open("/media/next.mp4");
  pending.resolve();
  await rig.advance();
  assert.equal(rig.loads.length, 0);
  assert.equal(rig.sid, 1);
  assert.equal(rig.sidebarMessages.at(-1).data.view, "idle");
});

test("automatic translation of the new video resumes after an old run releases the lock", async () => {
  const pending = deferred();
  const inputs = [];
  const rig = await loadIinaPlugin({ preferences: { autoTranslate: true }, createEngine: (deps) => ({ translateTrack: async (subtitle) => {
    const index = inputs.push(subtitle.content);
    if (index === 1) await pending.promise;
    const record = { bilingual: { path: `cache-run${index}.bilingual.ass`, content: `bilingual ${index}` },
      translationOnly: { path: `cache-run${index}.translation-only.ass`, content: `translation ${index}` } };
    await deps.storage.put(`run${index}`, record);
    return { status: "completed", cacheHit: false, cacheKey: `run${index}`, ...record };
  } }) });
  await rig.click(TRANSLATE);
  await rig.open("/media/next.mp4", { loaded: true });
  rig.files.set(SOURCE_PATH, "1\n00:00:01,000 --> 00:00:03,000\nBonjour from video B.");
  await rig.advance(800);
  assert.equal(inputs.length, 1, "wait for the previous run to settle before starting the new video");
  pending.resolve();
  await rig.advance();
  assert.equal(inputs.length, 2, "the blocked automatic request must run after the lock is released");
  assert.match(inputs[0], /Hello world/);
  assert.match(inputs[1], /Bonjour from video B/);
  assert.equal(rig.loads.length, 1);
  assert.match(rig.loads[0].path, /cache-run2\.bilingual\.ass$/);
});

test("variant mode changes explicitly select reloaded tracks without duplicates", async () => {
  const rig = await loadIinaPlugin();
  await rig.click(TRANSLATE);
  const bilingualId = rig.sid;
  await rig.click("仅译文");
  const translationId = rig.sid;
  assert.notEqual(translationId, bilingualId);
  await rig.click("双语");
  assert.equal(rig.loads.at(-1).reloaded, true);
  assert.equal(rig.sid, bilingualId, "sub-reload needs an explicit selection");
  await rig.click("关闭翻译字幕");
  assert.equal(rig.sid, 1);
  await rig.click("双语");
  assert.equal(rig.loads.at(-1).reloaded, true);
  assert.equal(rig.sid, bilingualId);
  assert.equal(rig.tracks.length, 3);
  assert.equal(translationRequests(rig).length, 1);
});

test("a manual track selection during translation is preserved until an explicit mode choice", async () => {
  const pending = deferred();
  const rig = await loadIinaPlugin({ translate: () => pending.promise });
  rig.addSource(2);
  await rig.click(TRANSLATE);
  rig.select(2);
  pending.resolve(translated(translationRequests(rig)[0]));
  await rig.advance();
  assert.equal(rig.sid, 2);
  assert.equal(rig.loads.length, 0);
  await rig.click("双语");
  assert.equal(rig.loads.length, 1);
  assert.notEqual(rig.sid, 2);
});

test("automatic cached loading rebuilds the current style without requesting the helper", async () => {
  const rig = await loadIinaPlugin();
  await rig.click(TRANSLATE);
  const filename = rig.loads[0].path;
  const before = rig.files.get(filename);
  const helperCalls = rig.helperMessages.length;
  const upstreamCalls = rig.requests.length;
  rig.prefs.set("fontSizeRatio", 0.5);
  rig.prefs.set("translationColor", "#FF0000");
  rig.prefs.set("lineOrder", "translationFirst");
  await rig.open(MEDIA_PATH, { loaded: true });
  await rig.advance(800);
  assert.equal(rig.loads.length, 2);
  assert.equal(rig.helperMessages.length, helperCalls);
  assert.equal(rig.requests.length, upstreamCalls);
  const refreshed = rig.files.get(filename);
  assert.notEqual(refreshed, before);
  assert.match(refreshed, /Style: Translation,Arial,18,&H000000FF/);
  assert.match(refreshed, /\[译\] Hello world\.\\N\{\\rOriginal\}Hello world\./);
  assert.notEqual(rig.sid, 1);
});
