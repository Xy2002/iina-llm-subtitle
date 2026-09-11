"use strict";

/**
 * Byte-level text decoding for runtimes without TextDecoder. Handles the BOM
 * cases subtitles actually arrive in; legacy 8-bit charsets (GB18030, Big5,
 * Shift-JIS, ...) are converted by the system iconv binary via the process
 * port (see extract.js convertLegacyToUtf8) — ffmpeg's own -sub_charenc
 * recoding is unreliable on macOS builds.
 */

/** @param {Uint8Array} bytes @returns {"utf-8" | "utf-16le" | "utf-16be" | null} */
function sniffEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/** @param {Uint8Array} bytes @param {boolean} littleEndian @returns {string} */
function decodeUtf16(bytes, littleEndian) {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    out += String.fromCharCode(unit);
  }
  return out;
}

/**
 * Decode subtitle bytes that carry a Unicode BOM; plain bytes pass through as
 * UTF-8 text (legacy charsets must be converted before reaching here).
 * @param {Uint8Array} bytes @returns {string}
 */
function decodeTextBytes(bytes) {
  const encoding = sniffEncoding(bytes);
  if (encoding === "utf-16le") return decodeUtf16(bytes.subarray(2), true);
  if (encoding === "utf-16be") return decodeUtf16(bytes.subarray(2), false);
  if (encoding === "utf-8") return utf8Decode(bytes.subarray(3));
  return utf8Decode(bytes);
}

/** @param {Uint8Array} bytes @returns {string} */
function utf8Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b0 < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (i + 3 < bytes.length) {
      const codepoint = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCharCode(0xd800 + ((codepoint - 0x10000) >> 10), 0xdc00 + ((codepoint - 0x10000) & 0x3ff));
      i += 4;
    } else {
      out += String.fromCharCode(b0);
      i += 1;
    }
  }
  return out;
}

module.exports = { sniffEncoding, decodeUtf16, decodeTextBytes };
