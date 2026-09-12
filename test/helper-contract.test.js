"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const ROOT = join(__dirname, "..");
// Test compilation must not overwrite the universal binary being packaged.
const suiteDirectory = mkdtempSync(join(tmpdir(), "iina-helper-contract-"));
const HELPER_BIN = join(suiteDirectory, "helper");
const SWIFTC = process.env.SWIFTC || "swiftc";

test.before(() => {
  execFileSync(SWIFTC, ["-O", "-swift-version", "5", "-module-cache-path", join(suiteDirectory, "swift-cache"), join(ROOT, "helper", "main.swift"), "-o", HELPER_BIN]);
});
test.after(() => rmSync(suiteDirectory, { recursive: true, force: true }));

function credentialsFile(baseUrl, apiKey = "sk-test") {
  const directory = mkdtempSync(join(suiteDirectory, "credentials-"));
  const path = join(directory, "credentials.json");
  if (baseUrl !== undefined) writeFileSync(path, JSON.stringify({ baseUrl, apiKey }), { mode: 0o600 });
  return path;
}

async function startHelper(t, options = {}) {
  const credentialsPath = options.credentialsPath || credentialsFile();
  const args = [
    "--credentials", credentialsPath,
    "--port", String(options.port ?? 0),
    "--idle-timeout", String(options.idleTimeout ?? 300),
    "--upstream-timeout", String(options.upstreamTimeout ?? 120),
    "--liveness-interval", String(options.livenessInterval ?? 0.1),
    "--completed-retention", String(options.completedRetention ?? 600),
    "--max-jobs", String(options.maxJobs ?? 32),
  ];
  const child = options.parentWrapper
    ? spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});", HELPER_BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    : spawn(HELPER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  let ready;
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    child.kill();
    if (options.parentWrapper && ready) {
      try { process.kill(ready.pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("helper did not become ready")); }, 8000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      const line = stdout.slice(0, newline).trim();
      clearTimeout(timer);
      if (line.startsWith("READY ")) resolve(JSON.parse(line.slice(6)));
      else if (line.startsWith("ERROR ")) reject(new Error(JSON.parse(line.slice(6)).message));
      else reject(new Error("unexpected helper handshake"));
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`helper exited early (${code}): ${stderr}`)); });
  });
  return { child, ready, credentialsPath, output: () => stdout + stderr };
}

function request(ready, path, { method = "GET", body, token = ready.token, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (text !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(text);
    }
    const req = http.request({ host: "127.0.0.1", port: ready.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("client request timeout")));
    req.end(text);
  });
}

function mockUpstream(t, handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const record = { authorization: req.headers.authorization, path: req.url, body };
        seen.push(record);
        Promise.resolve(handler(req, res, record)).catch((error) => res.destroy(error));
      });
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

async function pollResult(ready, id, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await request(ready, `/requests/${id}`);
    assert.equal(response.status, 200);
    if (response.json.state === "completed") return response.json.response;
    assert.equal(response.json.state, "pending");
    await delay(interval);
  }
  throw new Error("job did not complete");
}

function waitExit(child, timeout = 3000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper did not exit")), timeout);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

test("handshake starts without a credential file; only health is public", async (t) => {
  const { child, ready } = await startHelper(t);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  assert.equal(ready.pid, child.pid);
  assert.match(ready.token, /^[a-f0-9]{64}$/i);
  assert.deepEqual((await request(ready, "/health", { token: null })).json, { ok: true });
  assert.equal((await request(ready, "/credentials", { token: null })).status, 401);
  assert.equal((await request(ready, "/credentials", { token: "incorrect" })).status, 401);
  assert.deepEqual((await request(ready, "/credentials")).json, { configured: false, baseUrl: "" });
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "unconfigured", body: {} } })).status, 409);
});

test("credentials are helper-owned, 0600, partially updatable and never returned", async (t) => {
  const { ready, credentialsPath, output } = await startHelper(t);
  const url = "https://provider.invalid/v1";
  let response = await request(ready, "/credentials", { method: "POST", body: { baseUrl: url, apiKey: "sk-secret-fake" } });
  assert.deepEqual(response.json, { configured: true, baseUrl: url });
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(credentialsPath, "utf8")), { baseUrl: url, apiKey: "sk-secret-fake" });
  response = await request(ready, "/credentials", { method: "POST", body: { baseUrl: "https://other.invalid" } });
  assert.equal(response.json.configured, true);
  assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).apiKey, "sk-secret-fake");
  await request(ready, "/credentials", { method: "POST", body: { apiKey: "sk-rotated-fake" } });
  assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).baseUrl, "https://other.invalid");
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  const publicStatus = await request(ready, "/credentials");
  assert.deepEqual(Object.keys(publicStatus.json).sort(), ["baseUrl", "configured"]);
  assert.doesNotMatch(publicStatus.body + output(), /sk-secret-fake|sk-rotated-fake/);
  await Promise.all([
    request(ready, "/credentials", { method: "POST", body: { baseUrl: "https://concurrent.invalid" } }),
    request(ready, "/credentials", { method: "POST", body: { apiKey: "sk-concurrent-fake" } }),
  ]);
  assert.deepEqual(JSON.parse(readFileSync(credentialsPath, "utf8")), { baseUrl: "https://concurrent.invalid", apiKey: "sk-concurrent-fake" });
  await request(ready, "/credentials", { method: "POST", body: { apiKey: "" } });
  assert.equal((await request(ready, "/credentials")).json.configured, false);
  assert.equal(JSON.parse(readFileSync(credentialsPath, "utf8")).apiKey, "");
  assert.deepEqual(readdirSync(join(credentialsPath, "..")).sort(), ["credentials.json"]);
});

test("loose credential permissions are refused at startup and before updates", async (t) => {
  const path = credentialsFile("https://provider.invalid", "fake");
  chmodSync(path, 0o644);
  await assert.rejects(() => startHelper(t, { credentialsPath: path }), /0600/);
  chmodSync(path, 0o600);
  const { ready } = await startHelper(t, { credentialsPath: path });
  chmodSync(path, 0o644);
  assert.equal((await request(ready, "/credentials", { method: "POST", body: { apiKey: "replacement" } })).status, 500);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).apiKey, "fake");
});

test("submissions return before upstream completion, poll intact results and are idempotent", async (t) => {
  const payload = { choices: [{ message: { content: "translated" } }], usage: { total_tokens: 3 } };
  const upstream = await mockUpstream(t, async (_req, res) => { await delay(1200); res.end(JSON.stringify(payload)); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}/v1`) });
  const body = { model: "test-model", messages: [{ role: "user", content: "字幕 text ".repeat(5000) }] };
  const start = Date.now();
  const submission = await request(ready, "/requests", { method: "POST", body: { id: "job-1", body } });
  assert.equal(submission.status, 202);
  assert.deepEqual(submission.json, { id: "job-1", state: "pending" });
  assert.ok(Date.now() - start < 700, "submitting must not wait for the upstream");
  assert.equal((await request(ready, "/requests/job-1")).json.state, "pending");
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => request(ready, "/requests", { method: "POST", body: { id: "job-1", body } })));
  assert.ok(duplicates.every((response) => response.status === 202));
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "job-1", body: { model: "different" } } })).status, 409);
  assert.equal((await request(ready, "/requests/job-1", { method: "DELETE" })).status, 409);
  const result = await pollResult(ready, "job-1");
  assert.deepEqual(result, { status: 200, json: payload, text: JSON.stringify(payload), retryAfter: null });
  assert.equal(upstream.seen.length, 1);
  assert.deepEqual(JSON.parse(upstream.seen[0].body), body);
  assert.equal(upstream.seen[0].path, "/v1/chat/completions");
  assert.equal(upstream.seen[0].authorization, "Bearer sk-test");
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "job-1", body } })).json.state, "completed");
  assert.equal(upstream.seen.length, 1);
  assert.equal((await request(ready, "/requests/job-1", { method: "DELETE" })).status, 200);
  assert.equal((await request(ready, "/requests/job-1")).status, 404);
});

test("upstream HTTP errors and Retry-After remain in a successful poll envelope", async (t) => {
  const upstream = await mockUpstream(t, (_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
    res.end('{"error":{"message":"rate limited"}}');
  });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`) });
  await request(ready, "/requests", { method: "POST", body: { id: "rate", body: {} } });
  const result = await pollResult(ready, "rate");
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, "7");
  assert.deepEqual(result.json, { error: { message: "rate limited" } });
});

test("non-JSON upstream failures preserve their response text", async (t) => {
  const upstream = await mockUpstream(t, (_req, res) => { res.writeHead(502); res.end("provider unavailable"); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`) });
  await request(ready, "/requests", { method: "POST", body: { id: "bad-gateway", body: {} } });
  assert.deepEqual(await pollResult(ready, "bad-gateway"), { status: 502, text: "provider unavailable", json: null, retryAfter: null });
});

test("each submitted request snapshots credentials while later requests use rotations", async (t) => {
  const first = await mockUpstream(t, async (_req, res) => { await delay(200); res.end("{}"); });
  const second = await mockUpstream(t, (_req, res) => res.end("{}"));
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${first.port}`, "sk-before") });
  await request(ready, "/requests", { method: "POST", body: { id: "before", body: {} } });
  await request(ready, "/credentials", { method: "POST", body: { baseUrl: `http://127.0.0.1:${second.port}`, apiKey: "sk-after" } });
  await request(ready, "/requests", { method: "POST", body: { id: "after", body: {} } });
  await Promise.all([pollResult(ready, "before"), pollResult(ready, "after")]);
  assert.equal(first.seen.length, 1);
  assert.equal(first.seen[0].authorization, "Bearer sk-before");
  assert.equal(second.seen.length, 1);
  assert.equal(second.seen[0].authorization, "Bearer sk-after");
});

test("job capacity is bounded and completed records expire", async (t) => {
  const upstream = await mockUpstream(t, async (_req, res) => { await delay(120); res.end("{}"); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`), maxJobs: 1, completedRetention: 0.2 });
  await request(ready, "/requests", { method: "POST", body: { id: "first", body: {} } });
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "second", body: {} } })).status, 429);
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "first", body: {} } })).status, 202);
  await pollResult(ready, "first");
  await delay(250);
  assert.equal((await request(ready, "/requests/first")).status, 404);
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "second", body: {} } })).status, 202);
});

test("active upstream jobs survive idle timeout and completion restarts the idle clock", async (t) => {
  const upstream = await mockUpstream(t, async (_req, res) => { await delay(700); res.end("{}"); });
  const { ready, child } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`), idleTimeout: 0.2, livenessInterval: 0.025 });
  await request(ready, "/requests", { method: "POST", body: { id: "active", body: {} } });
  await delay(450); // No polling or health traffic keeps the helper alive here.
  assert.equal(child.exitCode, null);
  assert.equal((await request(ready, "/requests/active")).json.state, "pending");
  await pollResult(ready, "active");
  assert.equal(await waitExit(child), 0);
});

test("upstream timeout is a 504 job result, without timing out the polling client", async (t) => {
  const upstream = await mockUpstream(t, async (_req, res) => { await delay(1600); res.end("{}"); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`), upstreamTimeout: 0.5 });
  await request(ready, "/requests", { method: "POST", body: { id: "timeout", body: {} } });
  const result = await pollResult(ready, "timeout");
  assert.equal(result.status, 504);
  assert.match(result.json.error.message, /timeout/);
});

test("compatibility endpoint is authenticated and preserves upstream responses", async (t) => {
  const upstream = await mockUpstream(t, (_req, res) => { res.writeHead(429, { "Retry-After": "9" }); res.end("{}"); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`) });
  assert.equal((await request(ready, "/chat/completions", { method: "POST", body: {}, token: null })).status, 401);
  assert.equal(upstream.seen.length, 0);
  const response = await request(ready, "/chat/completions", { method: "POST", body: { model: "legacy" } });
  assert.equal(response.status, 429);
  assert.equal(response.headers["retry-after"], "9");
  assert.deepEqual(JSON.parse(upstream.seen[0].body), { model: "legacy" });
});

test("helper exits after its actual parent dies", async (t) => {
  const { child, ready } = await startHelper(t, { parentWrapper: true, livenessInterval: 0.05 });
  assert.notEqual(ready.pid, child.pid);
  child.kill("SIGKILL");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(ready.pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(25);
  }
  assert.fail("helper outlived its actual parent");
});

test("occupied explicit port fails predictably and a new helper recovers after a crash", async (t) => {
  const upstream = await mockUpstream(t, (_req, res) => res.end("{}"));
  await assert.rejects(() => startHelper(t, { port: upstream.port }), /cannot bind port/);
  const first = await startHelper(t);
  first.child.kill("SIGKILL");
  await waitExit(first.child);
  const second = await startHelper(t);
  assert.notEqual(first.ready.token, second.ready.token);
  assert.equal((await request(second.ready, "/health")).status, 200);
});

test("slow job exceeds 60 seconds while every client request remains short", { skip: process.env.IINA_HELPER_SLOW_TEST !== "1", timeout: 90000 }, async (t) => {
  const upstream = await mockUpstream(t, async (_req, res) => { await delay(65000); res.end('{"choices":[{"message":{"content":"long result"}}]}'); });
  const { ready } = await startHelper(t, { credentialsPath: credentialsFile(`http://127.0.0.1:${upstream.port}`), upstreamTimeout: 75 });
  const started = Date.now();
  assert.equal((await request(ready, "/requests", { method: "POST", body: { id: "slow", body: {} }, timeout: 1000 })).status, 202);
  assert.ok(Date.now() - started < 1000);
  const result = await pollResult(ready, "slow", { timeout: 80000, interval: 500 });
  assert.ok(Date.now() - started > 60000);
  assert.equal(result.status, 200);
  assert.equal(result.json.choices[0].message.content, "long result");
  assert.equal(upstream.seen.length, 1);
});
