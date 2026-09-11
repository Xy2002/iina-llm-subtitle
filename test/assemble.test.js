"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildBilingualAss, buildTranslationOnlyAss, assTime } = require("../src/engine/assemble.js");

const CUES = [
  { ordinal: 0, startMs: 1000, endMs: 3500, text: "Hello world." },
  { ordinal: 1, startMs: 4000, endMs: 6000, text: "Second cue." },
];
const TRANSLATIONS = ["[译] 你好，世界。", "[译] 第二条。"];

test("formats ASS timestamps as H:MM:SS.cc", () => {
  assert.equal(assTime(1000), "0:00:01.00");
  assert.equal(assTime(3567890), "0:59:27.89");
});

test("renders one bilingual dialogue per cue: original, style switch, translation", () => {
  const ass = buildBilingualAss(CUES, TRANSLATIONS);
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.50,Original,cue-0,.*Hello world\.\\N\{\\rTranslation\}\[译\] 你好，世界。/);
  assert.match(ass, /Dialogue: 0,0:00:04\.00,0:00:06\.00,Original,cue-1,.*Second cue\.\\N\{\\rTranslation\}\[译\] 第二条。/);
});

test("keeps the ASS skeleton with Original and Translation styles", () => {
  const ass = buildBilingualAss(CUES, TRANSLATIONS);
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /Style: Original,/);
  assert.match(ass, /Style: Translation,/);
});

test("bilingual assembly is deterministic for identical input", () => {
  assert.equal(buildBilingualAss(CUES, TRANSLATIONS), buildBilingualAss(CUES, TRANSLATIONS));
});

test("escapes ASS control characters in both lines", () => {
  const ass = buildBilingualAss(
    [{ ordinal: 0, startMs: 0, endMs: 1000, text: "a{b}\\c" }],
    ["[译] x{y}\\z"],
  );
  // Each brace gains a backslash; each backslash becomes backslash + word joiner.
  const expected = "a\\{b\\}\\\u2060c\\N{\\rTranslation}[译] x\\{y\\}\\\u2060z";
  assert.ok(ass.includes(expected), `expected escaped dialogue line:\n${ass}`);
});

test("translation-only variant renders one styled line per cue", () => {
  const ass = buildTranslationOnlyAss(CUES, TRANSLATIONS);
  assert.match(ass, /Dialogue: 0,0:00:01\.00,0:00:03\.50,Translation,cue-0,.*\[译\] 你好，世界。/);
  assert.match(ass, /Dialogue: 0,0:00:04\.00,0:00:06\.00,Translation,cue-1,.*\[译\] 第二条。/);
  assert.doesNotMatch(ass, /Hello world\./);
});

test("style options control translation color, size ratio and line order", () => {
  const styled = buildBilingualAss(CUES, TRANSLATIONS, {
    translationColor: "#FF8800",
    fontSizeRatio: 0.75,
    lineOrder: "translationFirst",
  });
  assert.match(styled, /Style: Translation,Arial,27,&H000088FF/);
  const line = styled.match(/Dialogue: 0,[^\n]*Translation,cue-0,[^\n]*/);
  assert.ok(line, "translation-first cue uses the Translation style");
  assert.ok(line[0].includes("[译] 你好，世界。") && line[0].includes("{\\rOriginal}Hello world."), line[0]);
});

test("invalid style colors fall back to the default accent", () => {
  const styled = buildBilingualAss(CUES, TRANSLATIONS, { translationColor: "#GG1111" });
  assert.match(styled, /&H0080E8FF/);
});

test("rejects mismatched cue and translation counts", () => {
  assert.throws(() => buildBilingualAss(CUES, ["[译] 只有一条。"]), /same length/);
  assert.throws(() => buildTranslationOnlyAss(CUES, []), /same length/);
});

test("style line values map 1:1 onto the declared format fields", () => {
  const ass = buildBilingualAss(CUES, TRANSLATIONS);
  const lines = ass.split("\n");
  const formatLine = lines.find((l) => l.startsWith("Format:"));
  const styleLine = lines.find((l) => l.startsWith("Style: Original"));
  const fields = formatLine.replace("Format:", "").split(",").map((f) => f.trim());
  // Style lines include the style name as the first field value.
  const values = ["Original", ...styleLine.replace("Style: Original,", "").split(",")];
  assert.equal(values.length, fields.length, `field/value count mismatch: ${values.length} vs ${fields.length}`);
  const mapped = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
  assert.equal(mapped.Alignment, "2", "bottom-center alignment");
  assert.equal(mapped.Shadow, "0");
  assert.equal(mapped.Encoding, "1");
});
