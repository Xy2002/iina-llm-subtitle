"use strict";

/** @typedef {{port: number, token: string}} HelperConnection */

/** @param {any} value @returns {any} */
function responseJson(value) {
  if (value && typeof value.data === "object" && value.data !== null) return value.data;
  try { return JSON.parse(value.text); } catch { return null; }
}

/**
 * IINA rejects HTTP errors with a response object. Preserve those responses;
 * only a failure without an HTTP status is a transport failure.
 * @param {any} http
 * @param {HelperConnection} connection
 * @param {"get" | "post" | "delete"} method
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<{status: number, json: any}>}
 */
async function helperRequest(http, connection, method, path, body) {
  const options = { headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` }, data: body };
  let response;
  try {
    response = await http[method](`http://127.0.0.1:${connection.port}${path}`, options);
  } catch (error) {
    const failure = /** @type {any} */ (error);
    if (!failure || !Number.isInteger(failure.statusCode) || failure.statusCode <= 0) {
      throw Object.assign(new Error("无法连接本地翻译助手。请重试。"), { code: "network" });
    }
    response = failure;
  }
  if (!response || !Number.isInteger(response.statusCode) || response.statusCode <= 0) {
    throw Object.assign(new Error("翻译助手未返回 HTTP 状态。"), { code: "network" });
  }
  return { status: response.statusCode, json: responseJson(response) };
}

/** @param {string | number | null | undefined} value @param {number} now */
function retryAfterSeconds(value, now) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : null;
}

/** @param {any} value @returns {string} */
function requestBodyKey(value) {
  return JSON.stringify(value, (_key, part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    return Object.fromEntries(Object.keys(part).sort().map((key) => [key, part[key]]));
  });
}

/**
 * Every loopback request finishes promptly while the helper owns the long
 * upstream operation. The completed envelope preserves status and headers.
 * @param {{http: any, getConnection: () => Promise<HelperConnection>, delay?: (ms: number) => Promise<void>, now?: () => number, makeId?: () => string}} deps
 */
function createJobTransport(deps) {
  const delay = deps.delay || ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  let sequence = 0;
  const prefix = Math.random().toString(36).slice(2);
  /** @typedef {{status: number, json: any, retryAfter: number | null}} JobResult */
  /** @typedef {{id: string, connection: HelperConnection | null, submitted: boolean, settled: boolean, inFlight: Promise<JobResult> | null}} PendingJob */
  /** Keep uncertain work across the batch translator's automatic retries. */
  /** @type {Map<string, PendingJob>} */
  const pendingJobs = new Map();

  /** Retry a short failed exchange against the same job, never resubmit it under a new id.
   * @param {HelperConnection} connection @param {"get" | "post"} method @param {string} path @param {any} [body] */
  async function exchange(connection, method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await helperRequest(deps.http, connection, method, path, body); }
      catch (error) {
        if (attempt >= 2) throw error;
        await delay(250 * (attempt + 1));
      }
    }
  }

  /** @param {PendingJob} job @param {any} body @returns {Promise<JobResult>} */
  async function continueJob(job, body) {
    if (!job.connection) job.connection = await deps.getConnection();
    const connection = job.connection;
    if (!job.submitted) {
      const accepted = await exchange(connection, "post", "/requests", { id: job.id, body });
      if (accepted.status !== 202 && accepted.status !== 200) {
        job.settled = true; // An explicit rejection did not accept this job.
        return { status: accepted.status, json: accepted.json, retryAfter: null };
      }
      job.submitted = true;
    }
    while (true) {
      const polled = await exchange(connection, "get", `/requests/${job.id}`);
      if (polled.status !== 200) {
        // Other polling failures do not tell us whether upstream work ran.
        if (polled.status === 404) job.settled = true;
        return { status: polled.status, json: polled.json, retryAfter: null };
      }
      const state = polled.json;
      if (state && state.id === job.id && state.state === "completed" && state.response && Number.isInteger(state.response.status)) {
        job.settled = true;
        const result = state.response;
        try { await helperRequest(deps.http, connection, "delete", `/requests/${job.id}`); } catch { /* retention also expires completed jobs */ }
        return { status: result.status, json: result.json, retryAfter: retryAfterSeconds(result.retryAfter, now()) };
      }
      if (!state || state.id !== job.id || state.state !== "pending") {
        throw Object.assign(new Error("翻译助手返回了无效的任务状态。"), { code: "network" });
      }
      await delay(250);
    }
  }

  return {
    /** @param {{path: string, body: any}} request */
    async postJson(request) {
      if (request.path !== "/chat/completions") throw new Error("不支持的翻译请求路径。");
      const key = requestBodyKey(request.body);
      let job = pendingJobs.get(key);
      if (!job) {
        job = {
          id: deps.makeId ? deps.makeId() : `${now()}-${prefix}-${++sequence}`,
          connection: null, submitted: false, settled: false, inFlight: null,
        };
        pendingJobs.set(key, job);
      }
      if (job.inFlight) return job.inFlight;
      const current = job;
      current.inFlight = continueJob(current, request.body).finally(() => {
        current.inFlight = null;
        if (current.settled && pendingJobs.get(key) === current) pendingJobs.delete(key);
      });
      return current.inFlight;
    },
  };
}

module.exports = { helperRequest, createJobTransport, retryAfterSeconds };
