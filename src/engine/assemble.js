"use strict";

/**
 * Subtitle assembly: turn cues plus their translations into the two render
 * variants chosen on the map — a bilingual ASS (original line, then a style
 * switch to the accented translation line) and a translation-only ASS.
 */

const ASS_HEADER_TEMPLATE = `[Script Info]
Title: iina-llm-subtitle
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Original,Arial,36,&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1
Style: Translation,Arial,TRANSLATION_SIZE,&H00TRANSLATION_COLOR,&H00TRANSLATION_COLOR,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/**
 * Style options applied at assembly time; changing them re-assembles from
 * stored translations without re-translation.
 * @typedef {{
 *   translationColor?: string,
 *   fontSizeRatio?: number,
 *   lineOrder?: "originalFirst" | "translationFirst",
 * }} AssemblyStyle
 */

const DEFAULT_STYLE = { translationColor: "FFE580", fontSizeRatio: 0.89 };

/** @param {string} hexColor @returns {string} ASS &HAABBGGRR from #RRGGBB */
function assColor(hexColor) {
  const hex = String(hexColor).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "80E8FF";
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  return `${b}${g}${r}`.toUpperCase();
}

/** @param {AssemblyStyle} [style] @returns {string} */
function assHeader(style) {
  const merged = { ...DEFAULT_STYLE, ...(style || {}) };
  return ASS_HEADER_TEMPLATE
    .replace("TRANSLATION_SIZE", String(Math.round(36 * merged.fontSizeRatio)))
    .replace("TRANSLATION_COLOR", assColor(merged.translationColor))
    .replace("TRANSLATION_COLOR", assColor(merged.translationColor));
}

/** @param {import('./index.js').Cue[]} cues @param {string[]} translations @param {AssemblyStyle} [style] @returns {string} */
function buildBilingualAss(cues, translations, style) {
  assertSameLength(cues, translations);
  const translationFirst = style && style.lineOrder === "translationFirst";
  const events = cues.map((cue, index) => {
    // ASS-native cues keep their inline override tags on the original line so
    // libass still applies the source styling; SRT text gets escaped.
    const original = cue.isAssNative ? cue.rawText : escapeAssText(cue.text);
    const translation = escapeAssText(translations[index]);
    const text = translationFirst
      ? `${translation}\\N{\\rOriginal}${original}`
      : `${original}\\N{\\rTranslation}${translation}`;
    return dialogueLine(cue, translationFirst ? "Translation" : "Original", text);
  });
  return assHeader(style) + events.join("\n") + "\n";
}

/**
 * @param {import('./index').Cue[]} cues
 * @param {string[]} translations
 * @returns {string}
 */
/** @param {import('./index.js').Cue[]} cues @param {string[]} translations @param {AssemblyStyle} [style] @returns {string} */
function buildTranslationOnlyAss(cues, translations, style) {
  assertSameLength(cues, translations);
  const events = cues.map((cue, index) => dialogueLine(cue, "Translation", escapeAssText(translations[index])));
  return assHeader(style) + events.join("\n") + "\n";
}

/**
 * @param {Array<{ordinal: number, startMs: number, endMs: number, text: string}>} cues
 * @param {string[]} translations
 */
function assertSameLength(cues, translations) {
  if (cues.length !== translations.length) {
    throw new Error(`Cues and translations must have the same length: ${cues.length} != ${translations.length}.`);
  }
}

/** @param {{ordinal: number, startMs: number, endMs: number}} cue @param {string} style @param {string} text @returns {string} */
function dialogueLine(cue, style, text) {
  return `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},${style},cue-${cue.ordinal},0,0,0,,${text}`;
}

/** @param {string} text @returns {string} */
function escapeAssText(text) {
  // libass recognizes escaped braces, but has no literal-backslash escape.
  // A word joiner prevents source sequences such as \N from becoming controls.
  return text.replace(/\\/g, "\\\u2060").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\n/g, "\\N");
}

/** @param {number} milliseconds @returns {string} */
function assTime(milliseconds) {
  const centiseconds = Math.floor(milliseconds / 10);
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const seconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

module.exports = { buildBilingualAss, buildTranslationOnlyAss, assTime };
