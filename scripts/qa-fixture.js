"use strict";

const { cpSync, mkdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const output = resolve(__dirname, "../artifacts/qa");
mkdirSync(output, { recursive: true });
cpSync(resolve(__dirname, "../test/fixtures/source.srt"), resolve(output, "native-track.srt"));
const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
  "-f", "lavfi", "-i", "color=c=0x20354a:s=1280x720:r=24:d=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", resolve(output, "native-track.mp4"),
], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Open ${resolve(output, "native-track.mp4")} in IINA; its adjacent SRT should load automatically.`);
