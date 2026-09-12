"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPreferences(language = "en-US", saved = {}) {
  const html = fs.readFileSync(path.join(__dirname, "../preferences.html"), "utf8");
  const elements = [];
  function element(tagName, attributes = {}, text = "") {
    const listeners = new Map();
    const node = {
      tagName, attributes, textContent: text, value: attributes.value || "", style: {},
      getAttribute: (key) => attributes[key] ?? null,
      setAttribute: (key, value) => { attributes[key] = value; },
      addEventListener: (event, listener) => listeners.set(event, listener),
      dispatchEvent: (event) => listeners.get(event.type)?.({ target: node }),
      appendChild: () => {},
    };
    elements.push(node);
    return node;
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]));
    const text = html.slice(match.index + match[0].length).split("<")[0].trim();
    element(match[1], attrs, text);
  }
  const document = {
    body: elements.find((node) => node.tagName === "body"),
    documentElement: elements.find((node) => node.tagName === "html"),
    createElement: (tag) => element(tag),
    getElementById: (id) => elements.find((node) => node.attributes.id === id),
    querySelectorAll: (selector) => {
      const match = selector.match(/^(\w+)?\[([\w-]+)\]$/);
      if (!match) throw new Error(`Unsupported DOM selector: ${selector}`);
      return elements.filter((node) => (!match[1] || node.tagName === match[1]) && node.attributes[match[2]] !== undefined);
    },
  };
  const reads = [];
  const writes = [];
  const api = {
    get: (key, callback) => { reads.push(key); callback(saved[key]); },
    set: (key, value) => { writes.push({ key, value }); },
  };
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInNewContext(script[1], { document, navigator: { language }, window: { iina: { preferences: api } }, Event: class { constructor(type) { this.type = type; } }, Date: { now: () => 1720000000123 } });
  }
  return { document, elements, reads, writes };
}

test("select preferences read persisted values and write changes through IINA", () => {
  const values = { targetLanguage: "ja", defaultMode: "translationOnly", lineOrder: "translationFirst" };
  const changed = { targetLanguage: "fr", defaultMode: "bilingual", lineOrder: "originalFirst" };
  const page = loadPreferences("en-US", values);
  const selects = page.document.querySelectorAll("select[data-pref-key]");
  assert.equal(selects.length, 3);
  for (const select of selects) {
    const key = select.getAttribute("data-pref-key");
    assert.ok(page.reads.includes(key), `load persisted ${key}`);
    assert.equal(select.value, values[key]);
    select.value = changed[key];
    select.dispatchEvent({ type: "change" });
    assert.deepEqual(page.writes.at(-1), { key, value: changed[key] });
  }
});

test("API key settings request a separate editor without exposing a secret preference", () => {
  const page = loadPreferences();
  assert.ok(page.elements.every((node) => node.getAttribute("data-pref-key") !== "apiKey"));
  assert.ok(!page.reads.includes("apiKey"));
  page.document.getElementById("setApiKeyButton").dispatchEvent({ type: "click" });
  assert.deepEqual(page.writes, [{ key: "credentialsEditRequested", value: 1720000000123 }]);
});

test("preferences render English and Chinese labels without helper implementation details", () => {
  const english = loadPreferences();
  const text = english.document.querySelectorAll("[data-i18n]").map((node) => node.textContent).join("\n");
  assert.doesNotMatch(text, /[\u3400-\u9fff]/);
  assert.doesNotMatch(text, /config\.json|helper\/bin|0600/);
  assert.equal(english.document.getElementById("setApiKeyButton").textContent, "Set API Key");
  const chinese = loadPreferences("zh-CN");
  assert.equal(chinese.document.getElementById("setApiKeyButton").textContent, "设置 API Key");
});
