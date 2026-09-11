"use strict";
const test = require("node:test");
const { before } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const { listSubtitleTracks, extractTrackToText, convertLegacyToUtf8 } = require("../src/engine/extract.js");
const { parseSubtitle } = require("../src/engine/index.js");
const realProcess = require("./helpers/node-process.js");

const FIXTURES = join(__dirname, "fixtures", "build");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const SOURCE_SRT = "1\n00:00:01,000 --> 00:00:03,500\nHello from embedded track.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond <i>line</i> here.\n";
const SOURCE_ASS = "[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Styled{\\i0} ASS line.\n";

before(() => {
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, "src.srt"), SOURCE_SRT);
  writeFileSync(join(FIXTURES, "src.ass"), SOURCE_ASS);
  // Legacy-charset fixtures: write UTF-8 then convert with system iconv.
  const legacy = (name, charset, text) => {
    const utf8Source = join(FIXTURES, `${name}.utf8`);
    writeFileSync(utf8Source, Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\n${text}\n`, "utf8"));
    const converted = execFileSync("/usr/bin/iconv", ["-f", "UTF-8", "-t", charset, utf8Source]);
    writeFileSync(join(FIXTURES, name), converted);
    rmSync(utf8Source);
  };
  legacy("legacy.gb.srt", "GB18030", "中文字幕传统编码测试。");
  legacy("legacy.sjis.srt", "SHIFT_JIS", "日本語字幕のテスト。");
  legacy("legacy.big5.srt", "BIG5", "繁體字幕編碼測試。");
  const mkv = (output, extra) =>
    execFileSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=10",
      "-i", join(FIXTURES, "src.srt"), "-i", join(FIXTURES, "src.ass"),
      "-map", "0:v", "-map", "1:s", "-map", "2:s",
      "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=jpn",
      "-c:v", "libx264", ...extra, output,
    ]);
  mkv(join(FIXTURES, "video.mkv"), ["-c:s", "copy"]);
  mkv(join(FIXTURES, "video.mp4"), ["-c:s", "mov_text"]);
});

test("golden: enumerates mkv text tracks with language metadata", async () => {
  const tracks = await listSubtitleTracks(realProcess, { ffprobe: FFPROBE, media: join(FIXTURES, "video.mkv") });
  assert.deepEqual(tracks, [
    { index: 1, codec: "subrip", lang: "eng", title: null, kind: "text" },
    { index: 2, codec: "ass", lang: "jpn", title: null, kind: "text" },
  ]);
});

test("golden: mkv srt extraction preserves exact timestamps and text", async () => {
  const { format, content } = await extractTrackToText(realProcess, { ffmpeg: FFMPEG, media: join(FIXTURES, "video.mkv"), track: { index: 1, codec: "subrip", kind: "text" } });
  assert.equal(format, "srt");
  // Golden literal: if a future ffmpeg re-bases these timestamps, this fails.
  assert.ok(content.includes("1\n00:00:01,000 --> 00:00:03,500\nHello from embedded track.\n"), content);
  assert.ok(content.includes("2\n00:00:04,000 --> 00:00:06,000\nSecond <i>line</i> here."), content);
  // Full chain: extracted content parses into aligned cues.
  const cues = parseSubtitle("srt", content);
  assert.deepEqual(
    cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs })),
    [
      { startMs: 1000, endMs: 3500 },
      { startMs: 4000, endMs: 6000 },
    ],
  );
  assert.equal(cues[1].text, "Second line here.");
});

test("golden: mp4 mov_text extraction round-trips text", async () => {
  const { format, content } = await extractTrackToText(realProcess, { ffmpeg: FFMPEG, media: join(FIXTURES, "video.mp4"), track: { index: 1, codec: "mov_text", kind: "text" } });
  assert.equal(format, "srt");
  assert.ok(content.includes("00:00:01,000 --> 00:00:03,500"), content);
  assert.ok(content.includes("Hello from embedded track."), content);
});

test("golden: ass extraction keeps inline override tags intact", async () => {
  const { format, content } = await extractTrackToText(realProcess, { ffmpeg: FFMPEG, media: join(FIXTURES, "video.mkv"), track: { index: 2, codec: "ass", kind: "text" } });
  assert.equal(format, "ass");
  assert.ok(content.includes("0:00:01.00,0:00:03.50"), content);
  assert.ok(content.includes("{\\i1}Styled{\\i0} ASS line."), content);
  // Chain to cues: raw text keeps tags, plain text is stripped.
  const cues = parseSubtitle("ass", content);
  assert.equal(cues[0].rawText, "{\\i1}Styled{\\i0} ASS line.");
  assert.equal(cues[0].text, "Styled ASS line.");
  assert.equal(cues[0].startMs, 1000);
});

test("golden: legacy GB18030 content converts to UTF-8 via system iconv", async () => {
  const text = await convertLegacyToUtf8(realProcess, { iconv: "/usr/bin/iconv", charset: "GB18030", inputPath: join(FIXTURES, "legacy.gb.srt") });
  assert.ok(text.includes("中文字幕传统编码测试。"), text);
  assert.ok(!text.includes("\ufffd"), "no replacement characters allowed");
});

test("golden: legacy Shift-JIS and Big5 convert cleanly", async () => {
  const toSjis = await convertLegacyToUtf8(realProcess, { iconv: "/usr/bin/iconv", charset: "SHIFT_JIS", inputPath: join(FIXTURES, "legacy.sjis.srt") });
  assert.ok(toSjis.includes("日本語字幕のテスト。"), toSjis);
  const toBig5 = await convertLegacyToUtf8(realProcess, { iconv: "/usr/bin/iconv", charset: "BIG5", inputPath: join(FIXTURES, "legacy.big5.srt") });
  assert.ok(toBig5.includes("繁體字幕編碼測試。"), toBig5);
});
