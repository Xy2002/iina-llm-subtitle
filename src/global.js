"use strict";

const { helperRequest } = require("./helper-client.js");
const { utils, file, preferences, global: players, console: log } = iina;
const CONFIG_PATH = "@data/config.json";
/** @type {import('./helper-client.js').HelperConnection | null} */
let connection = null;
/** @type {Promise<import('./helper-client.js').HelperConnection> | null} */
let starting = null;
/** @type {(path: string) => void} */
let acceptBundlePath;
const bundlePath = new Promise((resolve) => { acceptBundlePath = resolve; });
let launchGeneration = 0;
let lastCredentialRequest = Number(preferences.get("credentialsEditRequested")) || 0;
/** @type {Promise<void> | null} */
let migrating = null;
let migrated = false;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns {Promise<import('./helper-client.js').HelperConnection>} */
async function ensureHelper() {
  if (connection) return connection;
  if (starting) return starting;
  starting = (async () => {
    const override = String(preferences.get("helperPath") || "");
    // The bundled page supplies its own file URL, so renamed installs and
    // development symlinks resolve without guessing IINA's installation path.
    const directory = override ? "" : await Promise.race([
      bundlePath,
      wait(5000).then(() => { throw new Error("Credential page did not initialize."); }),
    ]);
    const binary = override ? utils.resolvePath(override) : `${directory}/helper-bin/iina-llm-subtitle-helper`;
    if (!file.exists(binary)) throw new Error("找不到翻译助手，请重新安装插件。 / Translation helper is missing; reinstall the plugin.");
    const generation = ++launchGeneration;
    let buffered = "";
    let stopped = false;
    utils.exec(binary, ["--credentials", utils.resolvePath(CONFIG_PATH), "--port", "0", "--idle-timeout", "300"], null,
      (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("READY ")) continue;
          try {
            const ready = JSON.parse(line.slice(6));
            if (generation === launchGeneration && Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535 && typeof ready.token === "string" && ready.token) {
              connection = { port: ready.port, token: ready.token };
            }
          } catch { log.error("Invalid helper handshake."); }
        }
      }, () => { /* never echo credentials or upstream content into logs */ }
    ).then(() => {
      stopped = true;
      if (generation === launchGeneration) connection = null;
    }, () => {
      stopped = true;
      if (generation === launchGeneration) connection = null;
    });
    for (let elapsed = 0; elapsed < 5000 && !connection && !stopped; elapsed += 50) await wait(50);
    if (!connection) throw new Error("翻译助手未就绪，请检查安装后重试。 / Translation helper did not start.");
    return connection;
  })();
  try { return await starting; } finally { starting = null; }
}

/** @param {import('./helper-client.js').HelperConnection} server */
async function migrateCredentials(server) {
  if (migrated) return;
  if (migrating) return migrating;
  migrating = (async () => {
    // Import non-secret settings from the old config once, each key on its
    // own: an upgraded install may already carry one setting (e.g. baseUrl)
    // in preferences while the rest still live only in the legacy file, and
    // posting credentials below rewrites the file and would erase them. The
    // existing credential file stays with the helper and is never copied to
    // prefs.
    if (file.exists(CONFIG_PATH)) {
      try {
        const legacy = JSON.parse(file.read(CONFIG_PATH, {}) || "{}");
        for (const key of ["baseUrl", "model", "targetLanguage", "ffmpegPath", "ffprobePath"]) {
          if (legacy[key] && !preferences.get(key)) preferences.set(key, legacy[key]);
        }
      } catch { log.error("Unable to import legacy provider settings."); }
    }
    const legacyKey = preferences.get("apiKey");
    if (typeof legacyKey === "string" && legacyKey) {
      const saved = await helperRequest(iina.http, server, "post", "/credentials", {
        apiKey: legacyKey, baseUrl: String(preferences.get("baseUrl") || ""),
      });
      if (saved.status !== 200) throw new Error("旧凭据迁移失败，原配置已保留。 / Credential migration failed; the old configuration was retained.");
      // Only clear the old copy once the helper has securely persisted it.
      preferences.set("apiKey", "");
    }
    preferences.sync();
    migrated = true;
  })();
  try { await migrating; } finally { migrating = null; }
}

/** @param {string} [baseUrl] */
async function configuredHelper(baseUrl) {
  const server = await ensureHelper();
  await migrateCredentials(server);
  let status = await helperRequest(iina.http, server, "get", "/credentials");
  if (baseUrl && status.json && status.json.baseUrl !== baseUrl) {
    status = await helperRequest(iina.http, server, "post", "/credentials", { baseUrl });
  }
  if (status.status !== 200) throw new Error("无法读取翻译凭据。 / Cannot read translation credentials.");
  return { connection: server, configured: Boolean(status.json && status.json.configured) };
}

players.onMessage("helper-request", async (request, player) => {
  if (!request || typeof request.id !== "string" || !player) return;
  try {
    const result = await configuredHelper(request.baseUrl);
    players.postMessage(player, "helper-response", { id: request.id, ...result });
  } catch {
    players.postMessage(player, "helper-response", { id: request.id, error: "翻译助手无法启动或读取凭据，请在设置中检查后重试。" });
  }
});

// Defer native WebView access until IINA has finished registering this entry.
setTimeout(() => {
  const editor = iina.standaloneWindow;
  editor.loadFile("credentials.html");
  editor.setProperty({ title: "API Key", resizable: false });
  editor.setFrame(440, 280, null, null);
  editor.onMessage("ready", async (data) => {
    const path = data && data.path;
    if (typeof path === "string" && path.startsWith("/") && path.endsWith("/credentials.html")) {
      acceptBundlePath(path.slice(0, -"/credentials.html".length));
    }
    try {
      if (preferences.get("apiKey") || file.exists(CONFIG_PATH)) await configuredHelper();
    } catch { log.error("Legacy credential migration is pending; open API key settings to retry."); }
  });
  editor.onMessage("save", async (data) => {
    if (!data || typeof data.apiKey !== "string") return;
    try {
      const server = await ensureHelper();
      const saved = await helperRequest(iina.http, server, "post", "/credentials", {
        apiKey: data.apiKey, baseUrl: String(preferences.get("baseUrl") || ""),
      });
      if (saved.status !== 200) throw new Error("save failed");
      preferences.set("apiKey", "");
      preferences.sync();
      editor.postMessage("saved", { configured: Boolean(data.apiKey.trim()) });
    } catch {
      editor.postMessage("save-error", {});
    }
  });
  editor.onMessage("close", () => editor.close());
  setInterval(() => {
    const requested = Number(preferences.get("credentialsEditRequested")) || 0;
    if (requested <= lastCredentialRequest) return;
    lastCredentialRequest = requested;
    editor.postMessage("reset", {});
    editor.open();
  }, 250);
}, 0);
