"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
let binaries;

test.before(() => {
  binaries = mkdtempSync(join(tmpdir(), "iina-package-binaries-"));
  const source = join(binaries, "helper.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  for (const [arch, minimum] of [["arm64", "11.0"], ["x86_64", "10.15"]]) {
    // Packaging only inspects/preserves Mach-O slices. Object files avoid
    // linking a second program against the developer machine's macOS SDK.
    execFileSync("xcrun", ["clang", "-c", "-target", `${arch}-apple-macosx${minimum}`, source, "-o", join(binaries, arch)]);
    chmodSync(join(binaries, arch), 0o755);
  }
  execFileSync("lipo", ["-create", join(binaries, "arm64"), join(binaries, "x86_64"), "-output", join(binaries, "universal")]);
  chmodSync(join(binaries, "universal"), 0o755);
});
test.after(() => rmSync(binaries, { recursive: true, force: true }));

function fixture(t, helperKind = "universal") {
  const root = mkdtempSync(join(tmpdir(), "iina-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "src", "helper/bin"]) mkdirSync(join(root, directory), { recursive: true });
  for (const script of ["build.js", "pack.js"]) cpSync(join(ROOT, "scripts", script), join(root, "scripts", script));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "Info.json"), JSON.stringify({ version: "1.0.0", entry: "main.js", globalEntry: "global.js" }));
  for (const entry of ["main.js", "global.js"]) writeFileSync(join(root, "src", entry), "console.log('fixture');\n");
  for (const asset of ["preferences.html", "sidebar.html", "credentials.html", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    writeFileSync(join(root, asset), `fixture ${asset}\n`);
  }
  if (helperKind) cpSync(join(binaries, helperKind), join(root, "helper/bin/iina-llm-subtitle-helper"));
  return { root, output: join(root, "dist/llm-subtitle-prototype.iinaplugin") };
}

test("distributed plugin includes both entry points, all UI pages, notices, and a universal helper", (t) => {
  const { root, output } = fixture(t);
  execFileSync(process.execPath, [join(root, "scripts/build.js")]);
  for (const asset of ["sidebar.html", "credentials.html", "preferences.html", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(readFileSync(join(output, asset), "utf8"), `fixture ${asset}\n`);
  }
  const manifest = JSON.parse(readFileSync(join(output, "Info.json"), "utf8"));
  for (const entry of [manifest.entry, manifest.globalEntry]) assert.ok(existsSync(join(output, entry)), `missing ${entry}`);
  const helper = join(output, "helper-bin/iina-llm-subtitle-helper");
  assert.deepEqual(execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/).sort(), ["arm64", "x86_64"]);
  execFileSync(process.execPath, [join(root, "scripts/pack.js")]);
  const archive = join(root, "dist/iina-llm-subtitle-1.0.0.iinaplgz");
  const contents = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n");
  for (const asset of ["main.js", "global.js", "sidebar.html", "credentials.html", "preferences.html", "LICENSE", "THIRD_PARTY_NOTICES.md", "helper-bin/iina-llm-subtitle-helper"]) {
    assert.ok(contents.includes(asset), `archive missing ${asset}`);
  }
});

for (const helperKind of [null, "arm64"]) {
  test(`build rejects ${helperKind ? "a helper missing the Intel slice" : "a missing helper"} before producing a package`, (t) => {
    const { root, output } = fixture(t, helperKind);
    const result = spawnSync(process.execPath, [join(root, "scripts/build.js")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /helper|x86_64/i);
    assert.equal(existsSync(output), false);
  });
}
