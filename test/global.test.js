"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const path = require("node:path");

function globalEntry(initialPreferences = {}, initialCredentials = {}) {
  const prefs = { baseUrl: "https://provider.invalid/v1", credentialsEditRequested: 0, ...initialPreferences };
  let credentials = { baseUrl: "", apiKey: "", ...initialCredentials };
  const savedPreferences = [], writes = [], launches = [], replies = [], posted = [];
  const editorEvents = {}, playerEvents = {}, timers = [], intervals = [];
  let opened = 0;
  let exitHelper;
  const iina = {
    preferences: { get: (key) => prefs[key], set: (key, value) => { prefs[key] = value; }, sync: () => savedPreferences.push({ ...prefs }) },
    file: { exists: (name) => name === "/renamed bundle/helper-bin/iina-llm-subtitle-helper" || (name === "@data/config.json" && Boolean(credentials.apiKey)), read: () => JSON.stringify(credentials) },
    utils: {
      resolvePath: (name) => name.replace("@data/", "/data/"),
      exec: (binary, args, _cwd, stdout) => {
        launches.push({ binary, args });
        stdout('REA'); stdout('DY {"port":34567,"pid":123,"token":"local-token"}\n');
        return new Promise((resolve) => { exitHelper = resolve; });
      },
    },
    http: {
      get: async (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer local-token");
        return { statusCode: 200, data: { configured: Boolean(credentials.baseUrl && credentials.apiKey), baseUrl: credentials.baseUrl } };
      },
      post: async (_url, options) => {
        writes.push({ ...options.data }); credentials = { ...credentials, ...options.data };
        return { statusCode: 200, data: { configured: Boolean(credentials.baseUrl && credentials.apiKey), baseUrl: credentials.baseUrl } };
      },
    },
    standaloneWindow: {
      loadFile: (name) => assert.equal(name, "credentials.html"), setProperty() {}, setFrame() {},
      onMessage: (name, fn) => { editorEvents[name] = fn; }, postMessage: (name, data) => posted.push({ name, data }),
      open: () => { opened += 1; }, close() {},
    },
    global: { onMessage: (name, fn) => { playerEvents[name] = fn; }, postMessage: (player, name, data) => replies.push({ player, name, data }) },
    console: { error() {} },
  };
  const sourcePath = path.resolve(__dirname, "../src/global.js");
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    iina, require: createRequire(sourcePath), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return String(timers.length); },
    setInterval: (fn) => { intervals.push(fn); return String(intervals.length); },
  }, { filename: sourcePath });
  timers.find((timer) => timer.ms === 0).fn();
  return { prefs, savedPreferences, writes, launches, replies, posted, editorEvents, playerEvents, timers, intervals, opened: () => opened,
    exit: () => exitHelper({ status: 0 }), credentials: () => credentials };
}

test("global entry discovers bundled helper from its own page and serves requests without a player-created window", async () => {
  const app = globalEntry();
  await app.editorEvents.ready({ path: "/renamed bundle/credentials.html" });
  assert.equal(app.opened(), 0);
  app.prefs.credentialsEditRequested = 123;
  app.intervals[0]();
  assert.equal(app.opened(), 1);
  await app.editorEvents.save({ apiKey: "fake-key" });
  await app.playerEvents["helper-request"]({ id: "player-request", baseUrl: app.prefs.baseUrl }, "player-label");
  assert.equal(app.launches[0].binary, "/renamed bundle/helper-bin/iina-llm-subtitle-helper");
  assert.ok(app.launches[0].args.includes("/data/config.json"));
  assert.equal(app.replies[0].player, "player-label");
  assert.equal(app.replies[0].data.configured, true);
  assert.equal(app.replies[0].data.connection.token, "local-token");
  assert.equal(app.credentials().apiKey, "fake-key");
  assert.ok(app.savedPreferences.every((snapshot) => !snapshot.apiKey));
  assert.ok(!JSON.stringify(app.posted).includes("fake-key"));
  assert.ok(!JSON.stringify(app.launches).includes("fake-key"));
});

test("legacy preference key is migrated before the persisted preference copy is cleared", async () => {
  const app = globalEntry({ apiKey: "legacy-fake-key", model: "model" });
  await app.editorEvents.ready({ path: "/renamed bundle/credentials.html" });
  assert.equal(app.writes[0].apiKey, "legacy-fake-key");
  assert.equal(app.credentials().apiKey, "legacy-fake-key");
  assert.equal(app.prefs.apiKey, "");
  assert.ok(app.savedPreferences.every((snapshot) => snapshot.apiKey === ""));
});

test("file-only legacy configuration imports non-secret provider settings without copying the key into prefs", async () => {
  const app = globalEntry({ baseUrl: "", model: "" }, { baseUrl: "https://legacy.invalid/v1", model: "legacy-model", apiKey: "file-only-fake" });
  await app.editorEvents.ready({ path: "/renamed bundle/credentials.html" });
  assert.equal(app.prefs.baseUrl, "https://legacy.invalid/v1");
  assert.equal(app.prefs.model, "legacy-model");
  assert.ok(!app.prefs.apiKey);
  assert.equal(app.credentials().apiKey, "file-only-fake");
  assert.ok(!JSON.stringify(app.savedPreferences).includes("file-only-fake"));
});

test("helper exit allows a fresh launch and empty key saves remove the credential", async () => {
  const app = globalEntry();
  await app.editorEvents.ready({ path: "/renamed bundle/credentials.html" });
  await app.editorEvents.save({ apiKey: "fake" });
  app.exit();
  await Promise.resolve();
  await app.editorEvents.save({ apiKey: "" });
  assert.equal(app.launches.length, 2);
  assert.equal(app.credentials().apiKey, "");
  assert.equal(app.posted.at(-1).data.configured, false);
});

test("a missing credential-page ready message times out and a later retry recovers", async () => {
  const app = globalEntry();
  const pending = app.playerEvents["helper-request"]({ id: "before-ready", baseUrl: app.prefs.baseUrl }, "player");
  app.timers.find((timer) => timer.ms === 5000).fn();
  await pending;
  assert.match(app.replies.at(-1).data.error, /助手/);
  assert.equal(app.launches.length, 0);
  await app.editorEvents.ready({ path: "/renamed bundle/credentials.html" });
  await app.playerEvents["helper-request"]({ id: "retry", baseUrl: app.prefs.baseUrl }, "player");
  assert.equal(app.replies.at(-1).data.connection.port, 34567);
  assert.equal(app.launches.length, 1);
});
