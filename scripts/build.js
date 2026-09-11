"use strict";

const { cpSync, mkdirSync, existsSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const output = resolve(root, "dist/llm-subtitle-prototype.iinaplugin");
// Clean first: stale files (e.g. engine/ from the pre-bundler era) must not
// ship in the package.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// Bundle the entry + engine into a single main.js: the plugin then never
// calls `require`, which sidesteps an IINA 1.4.4 polyfill crash (unowned
// self in the require closure traps after GC).
const { buildSync } = require("esbuild");
buildSync({
  entryPoints: [resolve(root, "src/main.js")],
  bundle: true,
  platform: "neutral",
  format: "cjs",
  target: "es2020",
  outfile: resolve(output, "main.js"),
});
cpSync(resolve(root, "Info.json"), resolve(output, "Info.json"));
cpSync(resolve(root, "preferences.html"), resolve(output, "preferences.html"));
const helperBinary = resolve(root, "helper/bin/iina-llm-subtitle-helper");
if (existsSync(helperBinary)) {
  mkdirSync(resolve(output, "helper-bin"), { recursive: true });
  cpSync(helperBinary, resolve(output, "helper-bin/iina-llm-subtitle-helper"));
} else {
  console.warn("helper binary missing; run npm run build:helper first");
}
console.log(output);
