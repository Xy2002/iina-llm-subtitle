"use strict";
const test = require("node:test");
const { before } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { chmodSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const HELPER_BIN = join(ROOT, "helper", "bin", "iina-llm-subtitle-helper");
const SWIFTC = process.env.SWIFTC || "swiftc";

function writeCredentials(dir, baseUrl, apiKey) {
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify({ baseUrl, apiKey }));
  chmodSync(path, 0o600);
  return path;
}

/** Spawn the helper; resolve {child, ready} where ready is the parsed READY frame. */
function startHelper(options) {
  const args = [
    "--credentials", options.credentialsPath,
    "--port", String(options.port ?? 0),
    "--parent-pid", String(options.parentPid ?? process.pid),
    "--idle-timeout", String(options.idleTimeout ?? 300),
    "--upstream-timeout", String(options.upstreamTimeout ?? 120),
    "--liveness-interval", String(options.livenessInterval ?? 5),
  ];
  const child = spawn(HELPER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper did not become ready")), 8000);
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      const line = buffered.slice(0, newline).trim();
      if (line.startsWith("READY ")) {
        resolve({ child, ready: JSON.parse(line.slice(6)) });
      } else if (line.startsWith("ERROR ")) {
        reject(Object.assign(new Error(JSON.parse(line.slice(6)).message)), { helperError: line, child });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`helper exited early (code ${code})`), { exitCode: code, stderr: buffered }));
    });
  });
}

/** Wait for process exit; resolve {code}. */
function waitExit(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

function request(port, path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("client request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/** Mock upstream server: records Authorization headers, replies per options. */
function mockUpstream(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ authorization: req.headers.authorization, path: req.url, body: Buffer.concat(chunks).toString("utf8") });
        handler(req, res);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

test.before(() => {
  execFileSync("mkdir", ["-p", join(ROOT, "helper", "bin")]);
  execFileSync(SWIFTC, ["-O", "-swift-version", "5", join(ROOT, "helper", "main.swift"), "-o", HELPER_BIN]);
});

test("handshake: READY frame with a valid ephemeral port and pid; health check answers", async () => {
  const dir = join(ROOT, "test", "fixtures", "build", "helper-smoke");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  const { child, ready } = await startHelper({ credentialsPath });
  try {
    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    assert.equal(ready.pid, child.pid);
    const health = await request(ready.port, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
  } finally {
    child.kill();
  }
});

test("proxy: forwards to the credentials base URL with the Bearer key and passes status, body and Retry-After back", async () => {
  const upstream = await mockUpstream((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const dir = join(ROOT, "test", "fixtures", "build", "helper-proxy");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, `http://127.0.0.1:${upstream.port}/v1`, "sk-secret-key");
  const { child, ready } = await startHelper({ credentialsPath });
  try {
    const response = await request(ready.port, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], "7");
    assert.deepEqual(JSON.parse(response.body), { error: { message: "rate limited" } });
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].authorization, "Bearer sk-secret-key");
    assert.ok(upstream.seen[0].path.endsWith("/chat/completions"));
  } finally {
    child.kill();
    upstream.server.close();
  }
});

test("credentials with loose permissions are refused at startup", async () => {
  const dir = join(ROOT, "test", "fixtures", "build", "helper-perms");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  chmodSync(credentialsPath, 0o644);
  await assert.rejects(
    () => startHelper({ credentialsPath }),
    (error) => /0600/.test(error.message),
  );
});

test("helper exits after its parent dies", async () => {
  // A short-lived stand-in parent: the helper watches ITS pid.
  const standIn = spawn("sleep", ["30"]);
  const dir = join(ROOT, "test", "fixtures", "build", "helper-parent");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  const { child } = await startHelper({ credentialsPath, parentPid: standIn.pid, livenessInterval: 1 });
  standIn.kill("SIGKILL");
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper outlived its parent")), 8000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
});

test("helper exits once the idle timeout elapses", async () => {
  const dir = join(ROOT, "test", "fixtures", "build", "helper-idle");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  const { child } = await startHelper({ credentialsPath, idleTimeout: 1, livenessInterval: 1 });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper never went idle-exit")), 8000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
});

test("an occupied explicit port fails fast with a predictable error", async () => {
  const blocker = await new Promise((resolve) => {
    const server = http.createServer(() => {});
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const occupiedPort = blocker.address().port;
  const dir = join(ROOT, "test", "fixtures", "build", "helper-port");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  await assert.rejects(
    () => startHelper({ credentialsPath, port: occupiedPort }),
    (error) => /cannot bind port/.test(error.message),
  );
  blocker.close();
});

test("proxy: a 200 upstream response passes through untouched", async () => {
  const upstream = await mockUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } }));
  });
  const dir = join(ROOT, "test", "fixtures", "build", "helper-200");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, `http://127.0.0.1:${upstream.port}/v1`, "sk-test");
  const { child, ready } = await startHelper({ credentialsPath });
  try {
    const response = await request(ready.port, "/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } });
  } finally {
    child.kill();
    upstream.server.close();
  }
});

test("credentials are re-read per request: rotating the key applies without restart", async () => {
  const seen = [];
  const upstream = await mockUpstream((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const dir = join(ROOT, "test", "fixtures", "build", "helper-rotate");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, `http://127.0.0.1:${upstream.port}/v1`, "sk-key-1");
  const { child, ready } = await startHelper({ credentialsPath });
  try {
    await request(ready.port, "/chat/completions", { method: "POST", body: "{}" });
    writeCredentials(dir, `http://127.0.0.1:${upstream.port}/v1`, "sk-key-2");
    await request(ready.port, "/chat/completions", { method: "POST", body: "{}" });
    assert.deepEqual(seen, ["Bearer sk-key-1", "Bearer sk-key-2"], "the rotated key must be used");
  } finally {
    child.kill();
    upstream.server.close();
  }
});

test("crash recovery: a fresh helper instance serves after a previous one dies", async () => {
  const dir = join(ROOT, "test", "fixtures", "build", "helper-recover");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, "http://127.0.0.1:9", "sk-test");
  const first = await startHelper({ credentialsPath });
  first.child.kill("SIGKILL");
  await waitExit(first.child);
  const second = await startHelper({ credentialsPath });
  try {
    const health = await request(second.ready.port, "/health");
    assert.equal(health.status, 200);
  } finally {
    second.child.kill();
  }
});

test("upstream timeout produces a 504 with an explanatory error body", async () => {
  const upstream = await mockUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 4000);
  });
  const dir = join(ROOT, "test", "fixtures", "build", "helper-timeout");
  mkdirSync(dir, { recursive: true });
  const credentialsPath = writeCredentials(dir, `http://127.0.0.1:${upstream.port}/v1`, "sk-test");
  const { child, ready } = await startHelper({ credentialsPath, upstreamTimeout: 1 });
  try {
    const response = await request(ready.port, "/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, 504);
    assert.match(JSON.parse(response.body).error.message, /timeout/);
  } finally {
    child.kill();
    upstream.server.close();
  }
});
