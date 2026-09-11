"use strict";

/**
 * Subtitle extraction: enumerate the text/bitmap tracks of a container via
 * ffprobe, then pull one text track out as SRT or ASS content on stdout.
 * All commands follow the empirically validated contract in
 * docs/research/embedded-extraction.md: -copyts is mandatory (ffmpeg 8.x
 * silently re-bases subtitle timestamps without it) and ASS/SSA tracks are
 * stream-copied, never transcoded (ffmpeg's ASS→SRT transcode is lossy).
 */

const TEXT_SUB_CODECS = new Set(["subrip", "ass", "ssa", "mov_text", "webvtt"]);
const BITMAP_SUB_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "dvb_teletext",
  "arib_caption",
]);

/** ffprobe per-stream entries we rely on. */
const PROBE_ENTRIES = "stream=index,codec_name,codec_type:stream_tags=language,title";

/**
 * @typedef {{index: number, codec: string, lang: string | null, title: string | null, kind: "text" | "bitmap" | "unknown"}} SubtitleTrack
 */

/**
 * @param {{run: (file: string, args: string[]) => Promise<{status: number, stdout: string, stderr: string}>}} process
 * @param {{ffprobe: string, media: string}} target
 * @returns {Promise<SubtitleTrack[]>}
 */
async function listSubtitleTracks(process, target) {
  const { status, stdout, stderr } = await process.run(target.ffprobe, [
    "-v", "error",
    "-show_entries", PROBE_ENTRIES,
    "-of", "json",
    target.media,
  ]);
  if (status !== 0) throw new Error(`ffprobe failed: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout);
  /** @type {any[]} */
  const streams = parsed.streams || [];
  return streams
    .filter((/** @type {{codec_type: string}} */ stream) => stream.codec_type === "subtitle")
    .map((/** @type {{index: number, codec_name: string, tags?: {language?: string, title?: string}}} */ stream) => ({
      index: stream.index,
      codec: stream.codec_name,
      lang: (stream.tags && stream.tags.language) || null,
      title: (stream.tags && stream.tags.title) || null,
      kind: TEXT_SUB_CODECS.has(stream.codec_name) ? "text" : BITMAP_SUB_CODECS.has(stream.codec_name) ? "bitmap" : "unknown",
    }));
}

/**
 * @param {{run: (file: string, args: string[]) => Promise<{status: number, stdout: string, stderr: string}>}} process
 * @param {{ffmpeg: string, media: string, track: {index: number, codec: string, kind: string}}} request
 * @returns {Promise<{format: "srt" | "ass", content: string}>}
 */
async function extractTrackToText(process, request) {
  const track = request.track;
  if (track.kind === "bitmap" || BITMAP_SUB_CODECS.has(track.codec)) {
    throw new Error(`该字幕轨是图像字幕（${track.codec}），需要 OCR 才能翻译，请选择文本字幕轨。`);
  }
  if (track.kind !== "text" && !TEXT_SUB_CODECS.has(track.codec)) {
    throw new Error(`暂不支持的字幕编码格式：${track.codec}。`);
  }
  const isAss = track.codec === "ass" || track.codec === "ssa";
  // -copyts is mandatory: ffmpeg 8.x silently re-bases subtitle timestamps
  // to zero without it. Content comes back on stdout (no temp files).
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-copyts", "-i", request.media, "-map", `0:${track.index}`];
  if (isAss) args.push("-c:s", "copy", "-f", "ass", "pipe:1");
  else args.push("-f", "srt", "pipe:1");
  const { status, stdout, stderr } = await process.run(request.ffmpeg, args);
  if (status !== 0) throw new Error(`ffmpeg 提取字幕失败：${stderr.trim()}`);
  return { format: isAss ? "ass" : "srt", content: stdout };
}

/**
 * Convert a legacy-encoded (GB18030/Big5/Shift-JIS/…) subtitle FILE to UTF-8
 * using the system iconv binary. ffmpeg's own -sub_charenc recoding is
 * unreliable on macOS Homebrew builds (verified: GB-family recodes fail), so
 * charset conversion goes through the platform iconv, which handles all of
 * the CJK charsets we care about. Charset detection itself is the caller's
 * job (BOM sniffing lives in bytes.js; legacy detection lands with the
 * external-file wiring).
 * @param {{run: (file: string, args: string[]) => Promise<{status: number, stdout: string, stderr: string}>}} process
 * @param {{iconv: string, charset: string, inputPath: string}} request
 * @returns {Promise<string>}
 */
async function convertLegacyToUtf8(process, request) {
  const { status, stdout, stderr } = await process.run(request.iconv, [
    "-f", request.charset,
    "-t", "UTF-8",
    request.inputPath,
  ]);
  if (status !== 0) throw new Error(`iconv 转换失败（${request.charset}）：${stderr.trim()}`);
  return stdout;
}

module.exports = { listSubtitleTracks, extractTrackToText, convertLegacyToUtf8, TEXT_SUB_CODECS, BITMAP_SUB_CODECS };
