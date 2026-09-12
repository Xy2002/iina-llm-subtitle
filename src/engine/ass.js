"use strict";

/**
 * ASS subtitle parsing. Tracks extracted with `-c:s copy` arrive as complete
 * ASS documents; this parser turns their dialogue events into engine cues.
 * Inline override tags ({\i1}, {\pos(...)}) are preserved on `rawText` so the
 * bilingual variant can re-emit the original line style-intact, and stripped
 * on `text` so the translator only ever sees plain words.
 */

/** @param {string} rawText @returns {{text: string, hasDrawing: boolean}} */
function visibleAssText(rawText) {
  let drawing = false;
  let hasDrawing = false;
  let text = "";
  for (const part of rawText.match(/\{[^}]*\}|[^{]+|\{/g) || []) {
    if (part.startsWith("{") && part.endsWith("}")) {
      for (const tag of part.matchAll(/\\p(\d+)/g)) drawing = Number(tag[1]) > 0;
    } else if (drawing) {
      if (part.trim()) hasDrawing = true;
    } else {
      text += part;
    }
  }
  return {
    text: text.replace(/\\h/g, " ").replace(/\\N/g, "\n").replace(/\\n/g, "\n"),
    hasDrawing,
  };
}

/** @param {string} text @returns {string} */
function stripAssTags(text) {
  return visibleAssText(text).text;
}

/** @param {string} timestamp @returns {number} */
function assTimestampMilliseconds(timestamp) {
  const parts = timestamp.split(":");
  const seconds = Number(parts[2].replace(",", "."));
  return ((Number(parts[0]) * 60 + Number(parts[1])) * 60 + seconds) * 1000;
}

/** @param {string} content @returns {import('./index.js').Cue[]} */
function parseAss(content) {
  const eventsSection = content.indexOf("[Events]");
  if (eventsSection === -1) throw new Error("No ASS dialogue events found.");
  const lines = content.slice(eventsSection).split(/\r?\n/);
  /** @type {string[] | null} */
  let format = null;
  /** @type {import('./index.js').Cue[]} */
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
      const visible = visibleAssText(text);
      if (endMs <= startMs || (!visible.text.trim() && !visible.hasDrawing)) continue;
      cues.push({
        ordinal: cues.length,
        startMs,
        endMs,
        text: visible.text,
        rawText: text,
        isAssNative: true,
        isDrawingOnly: !visible.text.trim() && visible.hasDrawing,
      });
    }
  }
  if (cues.length === 0) throw new Error("No ASS dialogue events found.");
  return cues;
}

module.exports = { parseAss, stripAssTags };
