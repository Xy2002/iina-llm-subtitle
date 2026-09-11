"use strict";
const { spawn } = require("node:child_process");

/**
 * Real process runner for golden-master tests. Same shape as the engine's
 * process port; in the plugin this is backed by iina.utils.exec instead.
 * @param {string} file @param {string[]} args @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status: status === null ? -1 : status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

module.exports = { run };
