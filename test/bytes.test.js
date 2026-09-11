"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { sniffEncoding, decodeUtf16, decodeTextBytes } = require("../src/engine/bytes.js");

/** @param {string} s @returns {Uint8Array} */
function bytesOf(...codes) {
  return new Uint8Array(codes);
}

test("sniffs UTF-8, UTF-16 LE/BE BOMs and no BOM", () => {
  assert.equal(sniffEncoding(bytesOf(0xef, 0xbb, 0xbf, 0x41)), "utf-8");
  assert.equal(sniffEncoding(bytesOf(0xff, 0xfe, 0x41, 0x00)), "utf-16le");
  assert.equal(sniffEncoding(bytesOf(0xfe, 0xff, 0x00, 0x41)), "utf-16be");
  assert.equal(sniffEncoding(bytesOf(0xe4, 0xbd, 0xa0)), null);
});

test("decodes UTF-16LE with BMP and supplementary characters", () => {
  // 中 (U+4E2D), 字 (U+5B57), 😀 (U+1F600 surrogate pair D83D DE00)
  const le = bytesOf(0x2d, 0x4e, 0x57, 0x5b, 0x3d, 0xd8, 0x00, 0xde);
  assert.equal(decodeUtf16(le, true), "中字\ud83d\ude00");
});

test("decodes UTF-16BE", () => {
  const be = bytesOf(0x4e, 0x2d, 0x5b, 0x57);
  assert.equal(decodeUtf16(be, false), "中字");
});

test("decodeTextBytes strips a UTF-8 BOM and decodes UTF-16 BOMs", () => {
  assert.equal(decodeTextBytes(bytesOf(0xef, 0xbb, 0xbf, 0x41)), "A");
  const le = bytesOf(0xff, 0xfe, 0x2d, 0x4e);
  assert.equal(decodeTextBytes(le), "中");
  assert.equal(decodeTextBytes(bytesOf(0x41)), "A");
});
