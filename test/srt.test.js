"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSrt } = require("../src/engine/srt.js");

test("parses a well-formed SRT into timed cues with stable ordinals", () => {
  const cues = parseSrt(
    "2\n00:00:01,000 --> 00:00:03,500\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond cue.",
  );
  assert.deepEqual(
    cues.map((cue) => ({ ordinal: cue.ordinal, startMs: cue.startMs, endMs: cue.endMs })),
    [
      { ordinal: 0, startMs: 1000, endMs: 3500 },
      { ordinal: 1, startMs: 4000, endMs: 6000 },
    ],
  );
  assert.equal(cues[0].text, "Hello world.");
});

test("tolerates a BOM, CRLF line endings and blank-line padding", () => {
  const cues = parseSrt("\uFEFF1\r\n00:00:00,500 --> 00:00:01,000\r\nHi.\r\n\r\n\r\n");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 500);
  assert.equal(cues[0].text, "Hi.");
});

test("joins multiline cue text with newlines", () => {
  const cues = parseSrt("1\n00:00:00,000 --> 00:00:02,000\nFirst line.\nSecond line.");
  assert.equal(cues[0].text, "First line.\nSecond line.");
});

test("flattens SRT markup and decodes entities", () => {
  const cues = parseSrt("1\n00:00:00,000 --> 00:00:02,000\n<i>Hello</i><br/>A &amp; B");
  assert.equal(cues[0].text, "Hello\nA & B");
});

test("rejects blocks that have no timestamp range", () => {
  assert.throws(() => parseSrt("1\nno timestamps here\ntext"), /cue 1/);
});

test("rejects cues whose end is not after their start", () => {
  assert.throws(() => parseSrt("1\n00:00:02,000 --> 00:00:02,000\nDuplicated."), /cue 1/);
});

test("rejects input with no cues at all", () => {
  assert.throws(() => parseSrt("   \n"), /No SRT cues/);
});
