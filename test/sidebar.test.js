"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSidebar(language = "en-US", initialState) {
  const html = fs.readFileSync(path.join(__dirname, "../sidebar.html"), "utf8");
  const nodes = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map((match) => {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]));
    const classes = new Set((attrs.class || "").split(/\s+/));
    const listeners = new Map();
    return {
      attrs, textContent: html.slice(match.index + match[0].length).split("<")[0].trim(), style: {}, disabled: false,
      getAttribute: (key) => attrs[key] ?? null,
      addEventListener: (event, handler) => listeners.set(event, handler),
      click() { if (!this.disabled) listeners.get("click")?.(); },
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name), contains: (name) => classes.has(name) },
    };
  });
  const handlers = new Map();
  const sent = [];
  const document = {
    documentElement: {},
    getElementById: (id) => nodes.find((node) => node.attrs.id === id),
    querySelectorAll: (selector) => {
      if (selector !== "[data-i18n]") throw new Error(`Unsupported DOM selector: ${selector}`);
      return nodes.filter((node) => node.attrs["data-i18n"]);
    },
  };
  const iina = {
    onMessage: (name, handler) => handlers.set(name, handler),
    postMessage: (name, data) => {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      if (name === "ready" && initialState) handlers.get("state")(initialState);
    },
  };
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1];
  vm.runInNewContext(script, { document, navigator: { language }, window: { iina } });
  return { document, sent, emit: (name, data) => handlers.get(name)(data), visible: (id) => !document.getElementById(id).classList.contains("hidden") };
}

test("sidebar localizes static text and restores a running snapshot after ready", () => {
  const page = loadSidebar("en-US", { view: "running", phase: "extraction", done: 2, total: 4 });
  assert.deepEqual(page.sent, [{ name: "ready", data: {} }]);
  const english = page.document.querySelectorAll("[data-i18n]").map((node) => node.textContent).join("\n");
  assert.doesNotMatch(english, /[\u3400-\u9fff]/);
  assert.equal(page.visible("progressView"), true);
  assert.equal(page.document.getElementById("phase").textContent, "Extracting subtitles");
  assert.equal(page.document.getElementById("count").textContent, "50% (2/4)");
  assert.equal(page.document.getElementById("fill").style.width, "50%");
  const chinese = loadSidebar("zh-CN");
  assert.equal(chinese.document.getElementById("cancelBtn").textContent, "取消");
});

test("sidebar state snapshots consistently render completion, errors, and new runs", () => {
  const page = loadSidebar();
  page.emit("progress", { phase: "translation", done: 4, total: 10 });
  assert.equal(page.document.getElementById("phase").textContent, "Translating");
  page.emit("state", { view: "completed" });
  assert.equal(page.visible("doneView"), true);
  assert.equal(page.visible("progressView"), false);
  assert.equal(page.visible("errorView"), false);
  assert.equal(page.document.getElementById("doneView").textContent, "Bilingual subtitles ready.");
  page.emit("state", { view: "error", errorMessage: "Network unavailable", cancelled: false });
  assert.equal(page.visible("errorView"), true);
  assert.match(page.document.getElementById("errorText").textContent, /Network unavailable/);
  page.emit("state", { view: "running", phase: "glossary", done: 0, total: 5 });
  assert.equal(page.visible("errorView"), false);
  assert.equal(page.document.getElementById("phase").textContent, "Glossary pre-check");
  assert.equal(page.document.getElementById("count").textContent, "0% (0/5)");
  page.emit("state", { view: "idle" });
  assert.equal(page.visible("idleView"), true);
  assert.equal(page.visible("doneView"), false);
});

test("cancel waits for a state reply and give up leaves navigation to the host", () => {
  const page = loadSidebar();
  page.emit("state", { view: "running", phase: "translation", done: 1, total: 4 });
  const cancel = page.document.getElementById("cancelBtn");
  cancel.click();
  assert.equal(cancel.disabled, true);
  assert.match(cancel.textContent, /Cancelling.*current batch/);
  assert.equal(page.sent.at(-1).name, "cancel");
  page.emit("progress", { phase: "translation", done: 2, total: 4 });
  assert.equal(cancel.disabled, true, "progress must not undo the pending cancellation");
  cancel.click();
  assert.equal(page.sent.filter((message) => message.name === "cancel").length, 1);
  page.emit("state", { view: "error", cancelled: true });
  assert.match(page.document.getElementById("errorText").textContent, /Cancelled/);
  page.document.getElementById("giveupBtn").click();
  assert.equal(page.sent.at(-1).name, "giveup");
  assert.equal(page.visible("errorView"), true, "host owns the next view");
  page.emit("state", { view: "idle" });
  assert.equal(page.visible("idleView"), true);
  page.emit("state", { view: "running", phase: "assembly", done: 0, total: 1 });
  assert.equal(cancel.disabled, false);
  assert.equal(cancel.textContent, "Cancel");
});
