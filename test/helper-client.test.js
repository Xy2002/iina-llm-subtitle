"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { helperRequest, createJobTransport, retryAfterSeconds } = require("../src/helper-client.js");
const connection = { port: 12345, token: "local-session" };

test("IINA rejected HTTP responses retain status and response body", async () => {
  for (const status of [401, 402, 429, 504]) {
    const http = { post: async () => { throw { statusCode: status, text: '{"error":{"message":"upstream error"}}' }; } };
    const response = await helperRequest(http, connection, "post", "/requests", {});
    assert.equal(response.status, status);
    assert.equal(response.json.error.message, "upstream error");
  }
  await assert.rejects(helperRequest({ get: async () => { throw new Error("offline"); } }, connection, "get", "/requests/id"), { code: "network" });
});

test("job polling spans more than 60 seconds through short exchanges and preserves upstream status", async () => {
  let now = 0;
  let polls = 0;
  const calls = [];
  const http = {
    post: async (url, options) => {
      calls.push({ url, options });
      return { statusCode: 202, data: { id: options.data.id, state: "pending" } };
    },
    get: async (url) => {
      assert.ok(url.endsWith("/requests/slow-job"));
      polls += 1;
      return { statusCode: 200, data: now < 65000 ? { id: "slow-job", state: "pending" } : {
        id: "slow-job", state: "completed", response: { status: 429, json: { error: { message: "rate limited" } }, retryAfter: "12" },
      } };
    },
    delete: async (url) => { calls.push({ url }); return { statusCode: 200, data: {} }; },
  };
  const transport = createJobTransport({ http, getConnection: async () => connection, now: () => now, makeId: () => "slow-job", delay: async (ms) => { now += ms; } });
  const result = await transport.postJson({ path: "/chat/completions", body: { model: "m" } });
  assert.equal(now, 65000);
  assert.equal(polls, 261);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, 12);
  assert.equal(result.json.error.message, "rate limited");
  assert.equal(calls[0].options.headers.Authorization, "Bearer local-session");
  assert.deepEqual(calls[0].options.data, { id: "slow-job", body: { model: "m" } });
  assert.ok(calls[1].url.endsWith("/requests/slow-job"));
});

test("lost submission response retries the same job id rather than creating duplicate work", async () => {
  const submitted = [];
  const transport = createJobTransport({
    getConnection: async () => connection, delay: async () => {}, makeId: () => "same-id",
    http: {
      post: async (_url, options) => {
        submitted.push(options.data.id);
        if (submitted.length === 1) throw new Error("response lost after submit");
        return { statusCode: 202, data: { id: "same-id", state: "pending" } };
      },
      get: async () => ({ statusCode: 200, data: { id: "same-id", state: "completed", response: { status: 200, json: { translations: [] }, retryAfter: null } } }),
      delete: async () => ({ statusCode: 200, data: {} }),
    },
  });
  await transport.postJson({ path: "/chat/completions", body: {} });
  assert.deepEqual(submitted, ["same-id", "same-id"]);
});

test("Retry-After supports delta seconds and HTTP dates", () => {
  assert.equal(retryAfterSeconds("3", 0), 3);
  assert.equal(retryAfterSeconds("Thu, 01 Jan 1970 00:00:10 GMT", 4000), 6);
  assert.equal(retryAfterSeconds("invalid", 0), null);
});

test("batch automatic retries recover the same job after all short polling retries fail", async () => {
  const { createBatchTranslator } = require("../src/engine/translate.js");
  const submitted = [];
  const deleted = [];
  let nextId = 0;
  let polls = 0;
  const transport = createJobTransport({
    getConnection: async () => connection, delay: async () => {}, makeId: () => `job-${++nextId}`,
    http: {
      post: async (_url, options) => {
        submitted.push(options.data);
        return { statusCode: 202, data: { id: options.data.id, state: "pending" } };
      },
      get: async (url) => {
        if (polls++ < 3) throw new Error("three lost loopback responses");
        return { statusCode: 200, data: {
          id: url.split("/").pop(), state: "completed",
          response: { status: 200, json: { translations: [{ id: "t0", text: "translated" }] }, retryAfter: null },
        } };
      },
      delete: async (url) => { deleted.push(url); return { statusCode: 200, data: {} }; },
    },
  });
  const run = createBatchTranslator({
    transport, glossaryPrecheck: false, maxRetries: 1, delay: async () => {}, random: () => 0,
    storage: { getState: async () => null, putState: async () => {} },
  });
  const result = await run([{ ordinal: 0, text: "one cue" }], { cacheKey: "retry", model: "m", targetLanguage: "zh" });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.translationsById, { t0: "translated" });
  assert.equal(submitted.length, 1, "the engine retry must not pay for a second job");
  assert.equal(polls, 4);
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].endsWith("/requests/job-1"));
  await transport.postJson({ path: "/chat/completions", body: submitted[0].body });
  assert.equal(submitted.length, 2, "completed jobs must be released from the transport");
  assert.equal(submitted[1].id, "job-2");
});

test("lost submission responses keep their id across separate postJson attempts", async () => {
  const ids = [];
  let nextId = 0;
  const transport = createJobTransport({
    getConnection: async () => connection, delay: async () => {}, makeId: () => `submit-${++nextId}`,
    http: {
      post: async (_url, options) => {
        ids.push(options.data.id);
        if (ids.length <= 3) throw new Error("submission succeeded but response was lost");
        return { statusCode: 202, data: { id: options.data.id, state: "pending" } };
      },
      get: async () => ({ statusCode: 200, data: { id: "submit-1", state: "completed", response: { status: 200, json: {}, retryAfter: null } } }),
      delete: async () => ({ statusCode: 200, data: {} }),
    },
  });
  await assert.rejects(transport.postJson({ path: "/chat/completions", body: { model: "m" } }), { code: "network" });
  const result = await transport.postJson({ path: "/chat/completions", body: { model: "m" } });
  assert.equal(result.status, 200);
  assert.deepEqual(ids, ["submit-1", "submit-1", "submit-1", "submit-1"]);
});

test("concurrent bodies remain independent while equivalent bodies share uncertain work", async () => {
  const submitted = [];
  const pending = [];
  let nextId = 0;
  const transport = createJobTransport({
    getConnection: async () => connection, delay: async () => {}, makeId: () => `concurrent-${++nextId}`,
    http: {
      post: async (_url, options) => { submitted.push(options.data); return { statusCode: 202, data: { id: options.data.id, state: "pending" } }; },
      get: async (url) => new Promise((resolve) => pending.push({ id: url.split("/").pop(), resolve })),
      delete: async () => ({ statusCode: 200, data: {} }),
    },
  });
  const first = transport.postJson({ path: "/chat/completions", body: { model: "a", options: { x: 1, y: 2 } } });
  const same = transport.postJson({ path: "/chat/completions", body: { options: { y: 2, x: 1 }, model: "a" } });
  const other = transport.postJson({ path: "/chat/completions", body: { model: "b" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.length, 2);
  assert.equal(pending.length, 2);
  for (const job of pending) job.resolve({ statusCode: 200, data: { id: job.id, state: "completed", response: { status: 200, json: { job: job.id }, retryAfter: null } } });
  const results = await Promise.all([first, same, other]);
  assert.deepEqual(results[0], results[1]);
  assert.notDeepEqual(results[0].json, results[2].json);
});

test("a temporary HTTP polling failure also keeps the existing job", async () => {
  let submissions = 0;
  let polls = 0;
  const transport = createJobTransport({
    getConnection: async () => connection, delay: async () => {}, makeId: () => "retained",
    http: {
      post: async () => { submissions += 1; return { statusCode: 202, data: { id: "retained", state: "pending" } }; },
      get: async () => {
        if (polls++ === 0) throw { statusCode: 503, data: { error: { message: "temporary failure" } } };
        return { statusCode: 200, data: { id: "retained", state: "completed", response: { status: 429, json: {}, retryAfter: "9" } } };
      },
      delete: async () => ({ statusCode: 200, data: {} }),
    },
  });
  const request = { path: "/chat/completions", body: { model: "m" } };
  assert.equal((await transport.postJson(request)).status, 503);
  const result = await transport.postJson(request);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfter, 9);
  assert.equal(submissions, 1);
});
