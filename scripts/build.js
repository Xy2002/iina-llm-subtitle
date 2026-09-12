"use strict";

const { execFileSync } = require("node:child_process");
const { accessSync, constants, cpSync, mkdirSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const output = resolve(root, "dist/llm-subtitle-prototype.iinaplugin");
const helperBinary = resolve(root, "helper/bin/iina-llm-subtitle-helper");
try {
  accessSync(helperBinary, constants.X_OK);
  execFileSync("lipo", [helperBinary, "-verify_arch", "arm64", "x86_64"], { stdio: "pipe" });
} catch {
  throw new Error("A universal arm64 + x86_64 helper is required. Run npm run build:helper first.");
}
// Clean first: stale files (e.g. engine/ from the pre-bundler era) must not
// ship in the package.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// Bundle each entry with its imports: the plugin then never
// calls `require`, which sidesteps an IINA 1.4.4 polyfill crash (unowned
// self in the require closure traps after GC).
const { buildSync } = require("esbuild");
buildSync({
  entryPoints: [resolve(root, "src/main.js"), resolve(root, "src/global.js")],
  bundle: true,
  platform: "neutral",
  format: "cjs",
  target: "es2020",
  outdir: output,
});
for (const asset of ["Info.json", "preferences.html", "sidebar.html", "credentials.html", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  cpSync(resolve(root, asset), resolve(output, asset));
}
mkdirSync(resolve(output, "helper-bin"), { recursive: true });
cpSync(helperBinary, resolve(output, "helper-bin/iina-llm-subtitle-helper"));
console.log(output);
