"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAss, stripAssTags } = require("../src/engine/ass.js");

const ASS_DOC = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Arial,36,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Styled{\\i0} ASS line.
Dialogue: 0,0:00:04.00,0:00:06.50,Default,,0,0,0,,Two, commas, here.\\NSecond line\\hjoined.
`;

test("strips ASS override tags, keeps text and line structure", () => {
  assert.equal(stripAssTags("{\\i1}Styled{\\i0} ASS line."), "Styled ASS line.");
  assert.equal(stripAssTags("a{\\pos(1,2)}b"), "ab");
  assert.equal(stripAssTags("line one\\Nline two"), "line one\nline two");
  assert.equal(stripAssTags("joined\\hspace"), "joined space");
  assert.equal(stripAssTags("{\\an8}top"), "top");
});

test("parses ASS dialogues into cues, ignoring Marked= layer variants and commas in text", () => {
  const cues = parseAss(ASS_DOC);
  assert.equal(cues.length, 2);
  assert.deepEqual(
    cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs })),
    [
      { startMs: 1000, endMs: 3500 },
      { startMs: 4000, endMs: 6500 },
    ],
  );
  assert.equal(cues[1].text, "Two, commas, here.\nSecond line joined.");
});

test("keeps the raw tagged text as rawText while text is the plain version", () => {
  const cues = parseAss(ASS_DOC);
  assert.equal(cues[0].rawText, "{\\i1}Styled{\\i0} ASS line.");
  assert.equal(cues[0].text, "Styled ASS line.");
});

test("rejects an ASS document without dialogue events", () => {
  assert.throws(() => parseAss("[Script Info]\nnothing useful"), /No ASS dialogue/);
});
