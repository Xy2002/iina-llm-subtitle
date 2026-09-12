"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE_SRT = "1\n00:00:01,000 --> 00:00:03,000\nHello world.";
const SOURCE_PATH = "/media/movie.srt";
const MEDIA_PATH = "/media/movie.mp4";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Run the real plugin entry through its IINA menu, event and WebView boundaries. */
async function loadIinaPlugin(options = {}) {
  const entry = path.resolve(__dirname, "../../src/main.js");
  const files = new Map([[SOURCE_PATH, SOURCE_SRT]]);
  const readErrors = new Set();
  const prefs = new Map(Object.entries({ baseUrl: "https://llm.invalid", model: "test-model", ...options.preferences }));
  const messages = [];
  const logs = [];
  const loads = [];
  const selections = [];
  const helperMessages = [];
  const requests = [];
  const sidebarMessages = [];
  const events = new Map();
  const globalHandlers = new Map();
  const sidebarHandlers = new Map();
  const menus = [];
  const jobs = new Map();
  const timers = new Map();
  let pollFailuresLeft = options.pollFailures || 0;
  let clock = 0;
  let nextTimer = 1;
  let media = MEDIA_PATH;
  let sid = 1;
  let tracks = [{ id: 1, type: "sub", external: true, "external-filename": SOURCE_PATH, codec: "subrip", title: "English" }];
  const resolvePath = (filename) => filename.startsWith("@data") ? filename.replace("@data", "/data")
    : filename.startsWith("@sub/") ? tracks.find((track) => track.id === Number(filename.slice(5)))?.["external-filename"]
      : filename;
  const emit = (name, data) => { for (const handler of events.get(name) || []) handler(data); };
  const select = (id) => { sid = id; selections.push(id); emit("mpv.sid.changed", id); };
  const setTimer = (callback, delay, interval = false) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: clock + (delay || 0), interval: interval ? delay : 0 });
    return id;
  };
  async function flush() { await new Promise((resolve) => setImmediate(resolve)); }
  async function advance(milliseconds = 0) {
    const target = clock + milliseconds;
    await flush();
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock = target; return; }
      const [id, timer] = next;
      clock = timer.at;
      timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: clock + timer.interval });
      const returned = timer.callback();
      if (returned && typeof returned.catch === "function") returned.catch((error) => logs.push(String(error)));
      await flush();
    }
    throw new Error("Plugin scheduled too many timers in one advance");
  }
  const publicTrack = (track) => ({ id: track.id, isExternal: track.external, codec: track.codec,
    title: track.title, formattedTitle: track.title || `Track ${track.id}` });
  const subtitle = {
    get tracks() { return tracks.filter((track) => track.type === "sub").map(publicTrack); },
    get currentTrack() { const track = tracks.find((candidate) => candidate.id === sid); return track ? publicTrack(track) : null; },
    get id() { return sid; },
    set id(id) { select(id); },
    loadTrack(filename) {
      let track = tracks.find((candidate) => candidate.external && candidate["external-filename"] === filename);
      const reloaded = !!track;
      if (!track) {
        track = { id: Math.max(0, ...tracks.map((candidate) => candidate.id)) + 1, type: "sub", external: true,
          "external-filename": filename, codec: "ass", title: path.basename(filename) };
        tracks.push(track);
        // IINA's new sub-add selects the new track. Its sub-reload does not.
        select(track.id);
        emit("mpv.track-list.changed", tracks);
      }
      loads.push({ path: filename, id: track.id, reloaded });
    },
  };
  const http = {
    async post(url, request) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:9999\/requests$/);
      const envelope = request.data;
      const context = JSON.parse(envelope.body.messages[1].content);
      requests.push(context);
      let response;
      if (context.purpose === "glossary") response = { status: 200, json: { glossary: [] } };
      else if (options.translate) response = options.translate(context);
      else response = { status: 200, json: { translations: context.cues.map((cue) => ({ id: cue.id, text: `[译] ${cue.text}` })) } };
      jobs.set(envelope.id, Promise.resolve(response));
      return { statusCode: 202, data: { id: envelope.id, state: "pending" } };
    },
    async get(url) {
      const id = url.split("/").at(-1);
      if (pollFailuresLeft > 0) { pollFailuresLeft -= 1; throw new Error("loopback exchange lost"); }
      const response = await jobs.get(id);
      return { statusCode: 200, data: { id, state: "completed", response } };
    },
    async delete(url) { jobs.delete(url.split("/").at(-1)); return { statusCode: 200, data: {} }; },
  };
  const iina = {
    core: { subtitle, osd: (message) => messages.push(message) },
    menu: {
      item: (title, callback, settings) => ({ title, callback, ...settings, items: [], addSubMenuItem(item) { this.items.push(item); } }),
      addItem: (item) => menus.push(item),
    },
    file: {
      exists: (filename) => files.has(resolvePath(filename)),
      read: (filename) => {
        const resolved = resolvePath(filename);
        if (readErrors.has(resolved)) throw new Error("Source file is unreadable");
        return files.get(resolved);
      },
      write: (filename, content) => { files.set(resolvePath(filename), content); },
      delete: (filename) => { files.delete(resolvePath(filename)); },
      list: (directory) => [...files.keys()].filter((filename) => filename.startsWith(resolvePath(directory))).map((filename) => ({ filename: path.basename(filename) })),
    },
    utils: { resolvePath, exec: async (filename) => { throw new Error(`Unexpected subprocess: ${filename}`); } },
    mpv: {
      getString: (property) => property === "path" ? media : "",
      getNumber: (property) => property === "sid" ? sid : 0,
      getNative: (property) => property === "track-list" ? tracks.map((track) => ({ ...track })) : null,
    },
    event: { on: (name, handler) => { events.set(name, [...events.get(name) || [], handler]); } },
    http,
    preferences: { get: (key) => prefs.get(key), set: (key, value) => { prefs.set(key, value); } },
    console: { log: (message) => logs.push(message), error: (message) => logs.push(message) },
    global: {
      onMessage: (name, handler) => globalHandlers.set(name, handler),
      postMessage: (name, data) => {
        helperMessages.push({ name, data });
        if (name === "helper-request") queueMicrotask(() => globalHandlers.get("helper-response")({ id: data.id,
          configured: options.configured !== false, connection: { port: 9999, token: "test-token" } }));
      },
    },
    sidebar: {
      loadFile: () => {},
      show: () => {},
      onMessage: (name, handler) => sidebarHandlers.set(name, handler),
      postMessage: (name, data) => sidebarMessages.push({ name, data }),
    },
  };
  const realRequire = (specifier) => require(path.resolve(path.dirname(entry), specifier));
  vm.runInNewContext(fs.readFileSync(entry, "utf8"), {
    iina,
    require: (specifier) => specifier === "./engine/index.js" && options.createEngine
      ? { ...realRequire(specifier), createEngine: options.createEngine } : realRequire(specifier),
    setTimeout: (callback, delay) => setTimer(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => setTimer(callback, delay, true),
    clearInterval: (id) => timers.delete(id),
    console,
  }, { filename: entry });
  assert.equal(files.has("/data/load-error.txt"), false, files.get("/data/load-error.txt"));
  await advance(500);
  function findMenu(title, entries = menus) {
    for (const item of entries) { if (item.title === title) return item; const found = findMenu(title, item.items); if (found) return found; }
    return null;
  }
  return {
    files, prefs, readErrors, messages, logs, loads, selections, helperMessages, requests, sidebarMessages,
    advance, flush, get sid() { return sid; }, get tracks() { return tracks; },
    async click(title) { const item = findMenu(title); assert.ok(item, `Menu exists: ${title}`); assert.notEqual(item.enabled, false); item.callback(); await advance(); },
    async sidebar(name, data = {}) { assert.ok(sidebarHandlers.has(name), `Sidebar event exists: ${name}`); sidebarHandlers.get(name)(data); await advance(); },
    async emit(name, data) { emit(name, data); await advance(); },
    select,
    addSource(id = 2, filename = "/media/other.srt") { tracks.push({ id, type: "sub", external: true, "external-filename": filename, codec: "subrip", title: "Other" }); files.set(filename, SOURCE_SRT); },
    async open(filename = MEDIA_PATH, { loaded = false } = {}) {
      media = filename;
      sid = 1;
      tracks = [{ id: 1, type: "sub", external: true, "external-filename": SOURCE_PATH, codec: "subrip", title: "English" }];
      emit("iina.file-started");
      if (loaded) emit("iina.file-loaded");
      await advance();
    },
  };
}

module.exports = { loadIinaPlugin, deferred, SOURCE_PATH, MEDIA_PATH };
