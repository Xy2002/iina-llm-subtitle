"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { candidatesFor, parseVersion, isSupportedVersion, pickWorkingBinary } = require("../src/engine/ffmpeg.js");

test("candidate order: preference override, then system paths, then the downloaded copy", () => {
  const candidates = candidatesFor({ ffmpeg: "/custom/ffmpeg" }, "ffmpeg", "/data/bin/ffmpeg");
  assert.deepEqual(candidates, ["/custom/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/data/bin/ffmpeg"]);
});

test("without an override the downloaded copy is still the last resort", () => {
  const candidates = candidatesFor({ ffmpeg: "" }, "ffmpeg", "/data/bin/ffmpeg");
  assert.deepEqual(candidates, ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/data/bin/ffmpeg"]);
});

test("parses ffmpeg version banners", () => {
  assert.deepEqual(parseVersion("ffmpeg version 7.1 Copyright (c) 2000-2024"), { major: 7, minor: 1 });
  assert.deepEqual(parseVersion("ffprobe version 6.0 Copyright"), { major: 6, minor: 0 });
  assert.equal(parseVersion("garbage"), null);
});

test("version gate accepts modern and rejects ancient or garbage", () => {
  assert.equal(isSupportedVersion("ffmpeg version 7.1 Copyright"), true);
  assert.equal(isSupportedVersion("ffmpeg version 4.2.1"), true);
  assert.equal(isSupportedVersion("ffmpeg version 3.2"), false);
  assert.equal(isSupportedVersion(""), false);
});

function fakeProcess(responses) {
  const calls = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push(file);
      const response = responses[file] ?? responses.default;
      if (response.throw) throw response.throw;
      return { status: response.status ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
    },
  };
}

test("picks the first candidate whose probe passes", async () => {
  const process = fakeProcess({
    "/a/ffmpeg": { status: 1 },
    "/b/ffmpeg": { stdout: "ffmpeg version 6.1 Copyright" },
    default: { stdout: "ffmpeg version 7.0" },
  });
  const result = await pickWorkingBinary(process, ["/a/ffmpeg", "/b/ffmpeg", "/c/ffmpeg"]);
  assert.equal(result.path, "/b/ffmpeg");
  assert.equal(result.version, "6.1");
  assert.deepEqual(process.calls, ["/a/ffmpeg", "/b/ffmpeg"]);
});

test("reports every failure when nothing works", async () => {
  const process = fakeProcess({
    "/a/ffmpeg": { status: 1, stderr: "no such file" },
    "/b/ffmpeg": { stdout: "ffmpeg version 3.0" },
  });
  const result = await pickWorkingBinary(process, ["/a/ffmpeg", "/b/ffmpeg"]);
  assert.equal(result.path, null);
  assert.match(result.error, /\/a\/ffmpeg/);
  assert.match(result.error, /\/b\/ffmpeg/);
});
