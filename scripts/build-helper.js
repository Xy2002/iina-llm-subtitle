"use strict";

const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, renameSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const work = resolve(root, "dist/helper-build");
const output = resolve(root, "helper/bin/iina-llm-subtitle-helper");
mkdirSync(work, { recursive: true });
mkdirSync(resolve(root, "helper/bin"), { recursive: true });

// IINA 1.4 supports Catalina on Intel. Apple Silicon starts at Big Sur.
// Explicit targets keep the build host's newer OS out of the deployment target.
const slices = [];
for (const [arch, minimum] of [["arm64", "11.0"], ["x86_64", "10.15"]]) {
  const slice = resolve(work, `helper-${arch}`);
  execFileSync(process.env.SWIFTC || "swiftc", [
    "-O", "-swift-version", "5", "-target", `${arch}-apple-macosx${minimum}`,
    "-module-cache-path", resolve(work, "module-cache"),
    resolve(root, "helper/main.swift"), "-o", slice,
  ], { stdio: "inherit" });
  slices.push(slice);
}
const temporaryOutput = `${output}.tmp`;
execFileSync("lipo", ["-create", ...slices, "-output", temporaryOutput]);
execFileSync("lipo", [temporaryOutput, "-verify_arch", "arm64", "x86_64"]);
chmodSync(temporaryOutput, 0o755);
renameSync(temporaryOutput, output);
console.log(`${output} (arm64 + x86_64)`);
