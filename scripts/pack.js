"use strict";
// Pack the built plugin into a distributable .iinaplgz (zip with the plugin
// contents at the archive root, matching the official iina-plugin pack
// layout). Usage: node scripts/pack.js [--out <path>]

const { execFileSync } = require("node:child_process");
const { mkdirSync, existsSync, readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");

const root = resolve(__dirname, "..");
const pluginDir = resolve(root, "dist/llm-subtitle-prototype.iinaplugin");
const info = JSON.parse(require("node:fs").readFileSync(join(pluginDir, "Info.json"), "utf8"));
const defaultOut = resolve(root, `dist/iina-llm-subtitle-${info.version}.iinaplgz`);

const outArgIndex = process.argv.indexOf("--out");
const out = outArgIndex !== -1 ? resolve(process.argv[outArgIndex + 1]) : defaultOut;

if (!existsSync(join(pluginDir, "Info.json"))) {
  console.error(`Plugin not built: ${pluginDir} missing. Run npm run build first.`);
  process.exit(1);
}

mkdirSync(resolve(root, "dist"), { recursive: true });
// Contents at the archive root (Info.json at zip root), matching what the
// official iina-plugin pack produces.
execFileSync("/usr/bin/zip", ["-r", "-q", out, "."], { cwd: pluginDir });

const size = require("node:fs").statSync(out).size;
console.log(`${out} (${(size / 1024).toFixed(1)} KiB)`);
