"use strict";

/**
 * ffmpeg/ffprobe tool resolution (pure logic; the process port performs the
 * actual version calls). Order of preference, per the map decision:
 * preference override -> Homebrew/system locations -> the plugin's own
 * downloaded copy in @data/bin.
 */

/** @returns {{ffmpeg: string[], ffprobe: string[]}} */
function systemCandidates() {
  return {
    ffmpeg: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"],
    ffprobe: ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"],
  };
}

/**
 * Ordered candidate paths for one tool. The downloaded copy comes last: it is
 * the fallback, not the preference.
 * @param {{ffmpeg?: string, ffprobe?: string}} overrides
 * @param {"ffmpeg" | "ffprobe"} tool
 * @param {string} downloadedPath
 * @returns {string[]}
 */
function candidatesFor(overrides, tool, downloadedPath) {
  const candidates = [];
  const override = overrides[tool];
  if (override) candidates.push(override);
  candidates.push(...systemCandidates()[tool]);
  if (downloadedPath) candidates.push(downloadedPath);
  return candidates;
}

/**
 * ffmpeg -version output looks like:
 *   "ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers"
 * @param {string} output @returns {{major: number, minor: number} | null}
 */
function parseVersion(output) {
  const match = /version\s+(\d+)\.(\d+)/.exec(output || "");
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/**
 * Anything reasonably modern works; we only rely on the subtitle demuxers and
 * muxers that have been stable for a decade. Reject obviously ancient or
 * garbage output so a stray file at the path fails the version check.
 * @param {string} output @returns {boolean}
 */
function isSupportedVersion(output) {
  const version = parseVersion(output);
  return version !== null && version.major >= 4;
}

/**
 * Pick the first candidate whose version probe passes.
 * @param {{run: (file: string, args: string[]) => Promise<{status: number, stdout: string, stderr: string}>}} process
 * @param {string[]} candidates
 * @returns {Promise<{path: string, version: string} | {path: null, error: string}>}
 */
async function pickWorkingBinary(process, candidates) {
  /** @type {string[]} */
  const failures = [];
  for (const candidate of candidates) {
    let result;
    try {
      result = await process.run(candidate, ["-version"]);
    } catch (error) {
      failures.push(`${candidate}: ${error}`);
      continue;
    }
    if (result.status !== 0) {
      failures.push(`${candidate}: exit ${result.status}`);
      continue;
    }
    const version = parseVersion(result.stdout + result.stderr);
    if (!version || version.major < 4) {
      failures.push(`${candidate}: unsupported or unrecognizable version`);
      continue;
    }
    return { path: candidate, version: `${version.major}.${version.minor}` };
  }
  return { path: null, error: failures.join("; ") };
}

module.exports = { candidatesFor, parseVersion, isSupportedVersion, pickWorkingBinary, systemCandidates };
