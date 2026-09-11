"use strict";

const { mkdirSync, lstatSync, readlinkSync, symlinkSync } = require("node:fs");
const { homedir } = require("node:os");
const { resolve } = require("node:path");

const output = resolve(__dirname, "../dist/llm-subtitle-prototype.iinaplugin");
const directory = resolve(homedir(), "Library/Application Support/com.colliderli.iina/plugins");
const link = resolve(directory, "llm-subtitle-prototype.iinaplugin-dev");
mkdirSync(directory, { recursive: true });
const existing = lstatSync(link, { throwIfNoEntry: false });
if (existing) {
  if (!existing.isSymbolicLink() || readlinkSync(link) !== output) {
    throw new Error(`Refusing to replace an existing plugin: ${link}`);
  }
} else {
  symlinkSync(output, link);
}
console.log(`Development plugin: ${link}\nRestart IINA to load this build.`);
