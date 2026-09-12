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

test("drawing commands are excluded from text while their original events survive", () => {
  const drawing = "{\\p1}m 0 0 l 100 0 100 100 0 100";
  assert.equal(stripAssTags(`${drawing}{\\p0}Visible words`), "Visible words");
  assert.equal(stripAssTags(`Before{\\an8\\p2}m 0 0 l 20 20{\\p0} after`), "Before after");
  const cues = parseAss(`[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,${drawing}{\\p0}Visible words\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,${drawing}\n`);
  assert.equal(cues[0].text, "Visible words");
  assert.equal(cues[0].rawText, `${drawing}{\\p0}Visible words`);
  assert.equal(cues[1].text, "");
  assert.equal(cues[1].rawText, drawing);
  assert.equal(cues[1].isDrawingOnly, true);
  assert.deepEqual([cues[1].startMs, cues[1].endMs], [4000, 5000]);
});
