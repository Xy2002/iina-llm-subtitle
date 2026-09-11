"use strict";

/**
 * SRT parsing for the translation engine. Cue identity is the triple
 * (startMs, endMs, ordinal): SRT numbering is unstable across editors and
 * extractors, so the numeric index in the file is ignored.
 */

/** @param {string} text @returns {Array<{ordinal: number, startMs: number, endMs: number, text: string}>} */
function parseSrt(text) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new Error("No SRT cues found.");
  const blocks = normalized.split(/\n[ \t]*\n(?:[ \t]*\n)*/);
  /** @type {Array<{ordinal: number, startMs: number, endMs: number, text: string}>} */
  const cues = [];
  blocks.forEach((block, ordinal) => {
    const lines = block.split("\n");
    const timing = (lines[1] || "").trim().match(/^(\d{2}:\d{2}:\d{2},\d{3})[ \t]+-->[ \t]+(\d{2}:\d{2}:\d{2},\d{3})$/);
    if (!/^\d+$/.test(lines[0].trim()) || !timing || lines.length < 3 || !lines.slice(2).join("").trim()) {
      throw new Error(`Invalid SRT cue ${ordinal + 1}: expected an index, timestamp range, and text.`);
    }
    const startMs = timestampMilliseconds(timing[1]);
    const endMs = timestampMilliseconds(timing[2]);
    if (startMs === null || endMs === null || endMs <= startMs) {
      throw new Error(`Invalid SRT cue ${ordinal + 1}: timestamps must be valid and end after start.`);
    }
    const cueText = flattenSrtText(lines.slice(2).join("\n"));
    if (!cueText.trim()) throw new Error(`Invalid SRT cue ${ordinal + 1}: no visible text.`);
    cues.push({ ordinal, startMs, endMs, text: cueText });
  });
  return cues;
}

/** @param {string} text @returns {string} */
function flattenSrtText(text) {
  /** @type {Record<string, string>} */
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": "\u00A0" };
  return text
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:b|i|u|s|font)\b[^>]*>/gi, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => entities[entity]);
}

/** @param {string} timestamp @returns {number | null} */
function timestampMilliseconds(timestamp) {
  const parts = timestamp.split(/[:,]/).map(Number);
  if (parts[1] > 59 || parts[2] > 59) return null;
  return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000 + parts[3];
}

module.exports = { parseSrt };
