"use strict";

/**
 * ASS subtitle parsing. Tracks extracted with `-c:s copy` arrive as complete
 * ASS documents; this parser turns their dialogue events into engine cues.
 * Inline override tags ({\i1}, {\pos(...)}) are preserved on `rawText` so the
 * bilingual variant can re-emit the original line style-intact, and stripped
 * on `text` so the translator only ever sees plain words.
 */

/** @param {string} text @returns {string} */
function stripAssTags(text) {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\h/g, " ")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n");
}

/** @param {string} timestamp @returns {number} */
function assTimestampMilliseconds(timestamp) {
  const parts = timestamp.split(":");
  const seconds = Number(parts[2].replace(",", "."));
  return ((Number(parts[0]) * 60 + Number(parts[1])) * 60 + seconds) * 1000;
}

/** @param {string} content @returns {Array<{ordinal: number, startMs: number, endMs: number, text: string, rawText: string, isAssNative: boolean}>} */
function parseAss(content) {
  const eventsSection = content.indexOf("[Events]");
  if (eventsSection === -1) throw new Error("No ASS dialogue events found.");
  const lines = content.slice(eventsSection).split(/\r?\n/);
  /** @type {string[] | null} */
  let format = null;
  /** @type {Array<{ordinal: number, startMs: number, endMs: number, text: string, rawText: string, isAssNative: boolean}>} */
  const cues = [];
  for (const line of lines) {
    if (line.startsWith("Format:")) {
      format = line.slice("Format:".length).split(",").map((name) => name.trim().toLowerCase());
    } else if (line.startsWith("Dialogue:")) {
      if (!format) throw new Error("ASS Events section is missing its Format line.");
      const rawText = line.slice("Dialogue:".length).trim();
      // Text is the last field and may itself contain commas: split only the
      // declared field count, then rejoin the remainder.
      const parts = rawText.split(",");
      const textIndex = format.indexOf("text");
      const start = parts[format.indexOf("start")].trim();
      const end = parts[format.indexOf("end")].trim();
      const text = parts.slice(textIndex).join(",").trim();
      const startMs = assTimestampMilliseconds(start);
      const endMs = assTimestampMilliseconds(end);
      if (endMs <= startMs || !stripAssTags(text).trim()) continue;
      cues.push({
        ordinal: cues.length,
        startMs,
        endMs,
        text: stripAssTags(text),
        rawText: text,
        isAssNative: true,
      });
    }
  }
  if (cues.length === 0) throw new Error("No ASS dialogue events found.");
  return cues;
}

module.exports = { parseAss, stripAssTags };
