"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { listSubtitleTracks, extractTrackToText } = require("../src/engine/extract.js");

const PROBE_JSON = JSON.stringify({
  streams: [
    { index: 0, codec_name: "h264", codec_type: "video" },
    { index: 1, codec_name: "subrip", codec_type: "subtitle", tags: { language: "eng", title: "English" } },
    { index: 2, codec_name: "ass", codec_type: "subtitle", tags: { language: "jpn" } },
    { index: 3, codec_name: "hdmv_pgs_subtitle", codec_type: "subtitle" },
  ],
});

/** @param {string} stdout @returns {any} */
function fakeProcess(stdout) {
  return {
    /** @param {string} file @param {string[]} args @returns {Promise<{status: number, stdout: string, stderr: string}>} */
    run: async (file, args) => ({ status: 0, stdout, stderr: "", file, args }),
  };
}

test("lists subtitle tracks with codec, language, title and kind", async () => {
  const process = fakeProcess(PROBE_JSON);
  const tracks = await listSubtitleTracks(process, { ffprobe: "/opt/ffprobe", media: "movie.mkv" });
  assert.deepEqual(tracks, [
    { index: 1, codec: "subrip", lang: "eng", title: "English", kind: "text" },
    { index: 2, codec: "ass", lang: "jpn", title: null, kind: "text" },
    { index: 3, codec: "hdmv_pgs_subtitle", lang: null, title: null, kind: "bitmap" },
  ]);
});

test("runs ffprobe with absolute stream selection and json output", async () => {
  const seen = [];
  const process = {
    run: async (file, args) => {
      seen.push({ file, args });
      return { status: 0, stdout: JSON.stringify({ streams: [] }), stderr: "" };
    },
  };
  await listSubtitleTracks(process, { ffprobe: "/opt/ffprobe", media: "movie.mkv" });
  assert.equal(seen[0].file, "/opt/ffprobe");
  assert.ok(seen[0].args.includes("movie.mkv"));
  assert.ok(seen[0].args.some((arg) => arg.includes("codec_name")));
});

test("extracting a bitmap track fails with a user-facing OCR message", async () => {
  const process = fakeProcess(PROBE_JSON);
  await assert.rejects(
    () => extractTrackToText(process, { ffmpeg: "/opt/ffmpeg", media: "movie.mkv", track: { index: 3, codec: "hdmv_pgs_subtitle", kind: "bitmap" } }),
    /图像字幕|OCR/,
  );
});

test("extracting an unknown codec fails instead of guessing", async () => {
  const process = fakeProcess(PROBE_JSON);
  await assert.rejects(
    () => extractTrackToText(process, { ffmpeg: "/opt/ffmpeg", media: "movie.mkv", track: { index: 9, codec: "dvb_teletext", kind: "unknown" } }),
    /dvb_teletext/,
  );
});

test("srt-family extraction forces -copyts and reads from stdout", async () => {
  const seen = [];
  const process = {
    run: async (file, args) => {
      seen.push({ file, args });
      return { status: 0, stdout: "1\n00:00:01,000 --> 00:00:03,500\nHello\n", stderr: "" };
    },
  };
  const result = await extractTrackToText(process, { ffmpeg: "/opt/ffmpeg", media: "movie.mkv", track: { index: 1, codec: "subrip", kind: "text" } });
  assert.deepEqual(result, { format: "srt", content: "1\n00:00:01,000 --> 00:00:03,500\nHello\n" });
  const args = seen[0].args;
  assert.ok(args.includes("-copyts"), "copyts is mandatory");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2), ["-map", "0:1"]);
  assert.ok(args.includes("pipe:1"), "content must come from stdout, not temp files");
});

test("ass tracks are extracted with codec copy, not transcoded", async () => {
  const seen = [];
  const process = {
    run: async (file, args) => {
      seen.push({ file, args });
      return { status: 0, stdout: "[Events]\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}x", stderr: "" };
    },
  };
  const result = await extractTrackToText(process, { ffmpeg: "/opt/ffmpeg", media: "movie.mkv", track: { index: 2, codec: "ass", kind: "text" } });
  assert.equal(result.format, "ass");
  const args = seen[0].args;
  assert.deepEqual(args.slice(args.indexOf("-c:s"), args.indexOf("-c:s") + 2), ["-c:s", "copy"]);
  assert.ok(args.includes("-f") && args.includes("ass"));
});

test("mov_text tracks transcode to srt format", async () => {
  const seen = [];
  const process = {
    run: async (file, args) => {
      seen.push({ file, args });
      return { status: 0, stdout: "1\n00:00:00,000 --> 00:00:01,000\nHi\n", stderr: "" };
    },
  };
  const result = await extractTrackToText(process, { ffmpeg: "/opt/ffmpeg", media: "movie.mp4", track: { index: 1, codec: "mov_text", kind: "text" } });
  assert.equal(result.format, "srt");
  const args = seen[0].args;
  assert.ok(args.includes("-f") && args.includes("srt"));
  assert.ok(!args.includes("copy"));
});

test("legacy charset conversion goes through the iconv binary", async () => {
  const seen = [];
  const process = {
    run: async (file, args) => {
      seen.push({ file, args });
      return { status: 0, stdout: "1\n00:00:00,000 --> 00:00:01,000\n中文\n", stderr: "" };
    },
  };
  const { convertLegacyToUtf8 } = require("../src/engine/extract.js");
  const text = await convertLegacyToUtf8(process, { iconv: "/usr/bin/iconv", charset: "GB18030", inputPath: "/tmp/sub.srt" });
  assert.equal(text, "1\n00:00:00,000 --> 00:00:01,000\n中文\n");
  assert.deepEqual(seen[0].args, ["-f", "GB18030", "-t", "UTF-8", "/tmp/sub.srt"]);
});

test("non-zero ffmpeg status surfaces the stderr", async () => {
  const process = {
    run: async () => ({ status: 234, stdout: "", stderr: "Subtitle encoding currently only possible from text to text or bitmap to bitmap" }),
  };
  await assert.rejects(
    () => extractTrackToText(process, { ffmpeg: "ffmpeg", media: "x.mkv", track: { index: 1, codec: "subrip", kind: "text" } }),
    /text to text/,
  );
});
