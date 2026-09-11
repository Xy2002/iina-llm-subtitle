"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { sha256Hex } = require("../src/engine/sha256.js");

test("hashes the NIST \"abc\" vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashes the empty string vector", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("hashes the two-block vector", () => {
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("hashes multibyte UTF-8 text like Node's crypto", () => {
  // Reference value taken from: node -e "console.log(require('crypto').createHash('sha256').update('字幕翻译','utf8').digest('hex'))"
  assert.equal(sha256Hex("字幕翻译"), "0642798a43317dd8fbc53610a5acc9074a234fca317c7a1f34c7e59989dfb676");
});
