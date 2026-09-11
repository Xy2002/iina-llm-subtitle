"use strict";

"use strict";

try {

const { createEngine, variantPaths, parseSubtitle } = require("./engine/index.js");
const { listSubtitleTracks, extractTrackToText } = require("./engine/extract.js");
const { pickWorkingBinary, candidatesFor } = require("./engine/ffmpeg.js");
// NOTE: iina.sidebar is accessed lazily (see deferred init below) — touching
// the getter at entry load crashes IINA 1.4.4 (EXC_BREAKPOINT in
// JavascriptPolyfill.register).
const { core, menu, file, utils, mpv, event, http, preferences, console: log } = iina;

// Transitional configuration until the settings ticket (MAR-99): the user
// drops a 0600 config file into the plugin data directory. The helper reads
// the same file as its credential source, so the key exists in exactly one
// place and never in argv, env, or logs.
//
// {
//   "baseUrl": "https://api.example.com/v1",
//   "apiKey": "...",
//   "model": "...",
//   "targetLanguage": "zh-Hans",       // optional, default zh-Hans
//   "ffmpegPath": "/opt/homebrew/bin/ffmpeg",  // optional
//   "ffprobePath": "/opt/homebrew/bin/ffprobe" // optional
// }
const CONFIG_PATH = "@data/config.json";
const DOWNLOADED_FFMPEG = "@data/bin-ffmpeg";
const DOWNLOADED_FFPROBE = "@data/bin-ffprobe";
const DEFAULT_TOOL_DOWNLOAD_BASE = "https://github.com/weixiangyu/iina-llm-subtitle/releases/latest/download";
const HELPER_IDLE_TIMEOUT = 300;

/**
 * @typedef {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   targetLanguage?: string,
 *   ffmpegPath?: string,
 *   ffprobePath?: string,
 *   helperPath?: string,
 *   maxBatchChars?: number,
 *   maxRetries?: number,
 *   defaultMode?: string,
 *   translationColor?: string,
 *   fontSizeRatio?: number,
 *   lineOrder?: string,
 *   autoTranslate?: boolean,
 *   translateHotkey?: string,
 *   cacheLimitMB?: number,
 *   clearCacheRequested?: number,
 *   ffmpegForceBundled?: boolean,
 *   ffmpegDownloadBaseUrl?: string,
 * }} PluginConfig
 */

// MARK: storage port (flat file names — IINA file.write cannot mkdir)

/** @param {string} key @returns {string} */
function statePath(key) {
  return `cache-${key}.state.json`;
}

const storage = {
  /** @param {string} key @returns {Promise<any | null>} */
  /** @param {string} key */
  get: async (key) => {
    const paths = variantPaths(key);
    const prefix = `@data/`;
    if (!file.exists(`${prefix}${paths.bilingual}`) || !file.exists(`${prefix}${paths.translationOnly}`)) return null;
    const bilingual = file.read(`${prefix}${paths.bilingual}`, {});
    const translationOnly = file.read(`${prefix}${paths.translationOnly}`, {});
    if (typeof bilingual !== "string" || typeof translationOnly !== "string") return null;
    return {
      bilingual: { path: paths.bilingual, content: bilingual },
      translationOnly: { path: paths.translationOnly, content: translationOnly },
    };
  },
  /** @param {string} key @param {any} record @returns {Promise<void>} */
  put: async (key, record) => {
    file.write(`@data/${record.bilingual.path}`, record.bilingual.content);
    file.write(`@data/${record.translationOnly.path}`, record.translationOnly.content);
  },
  /** @param {string} key */
  getState: async (key) => {
    const path = `@data/${statePath(key)}`;
    if (!file.exists(path)) return null;
    const raw = file.read(path, {});
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      log.error(`corrupt state file ignored: ${error}`);
      return null;
    }
  },
  /** @param {string} key @param {any} state */
  putState: async (key, state) => {
    file.write(`@data/${statePath(key)}`, JSON.stringify(state));
  },
  /** @param {string} key */
  clearState: async (key) => {
    const path = `@data/${statePath(key)}`;
    if (file.exists(path)) file.delete(path);
  },
  /** @param {string} key @returns {Promise<string[] | null>} */
  getTranslations: async (key) => {
    const path = `@data/${translationsPath(key)}`;
    if (!file.exists(path)) return null;
    const raw = file.read(path, {});
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      log.error(`corrupt translations file ignored: ${error}`);
      return null;
    }
  },
  /** @param {string} key @param {string[]} translations @returns {Promise<void>} */
  putTranslations: async (key, translations) => {
    file.write(`@data/${translationsPath(key)}`, JSON.stringify(translations));
  },
};

/** @param {string} key @returns {string} */
function translationsPath(key) {
  return `cache-${key}.translations.json`;
}

// MARK: helper lifecycle

const helper = { port: null, desired: false };

/** @param {string} line */
function helperReadyFrame(line) {
  if (!line.startsWith("READY ")) return;
  try {
    helper.port = JSON.parse(line.slice(6)).port;
    log.log(`helper ready on 127.0.0.1:${helper.port}`);
  } catch (error) {
    log.error(`bad helper READY frame: ${error}`);
  }
}

/** Launch the helper and resolve once its READY frame names a port. */
/** @param {PluginConfig} config */
async function ensureHelper(config) {
  if (helper.port) return helper.port;
  helper.desired = true;
  if (!config.helperPath) throw Object.assign(new Error("配置缺少 helperPath（编译产物 helper/bin/iina-llm-subtitle-helper 的绝对路径）"), { classification: "config" });
  const helperBinary = config.helperPath;
  const configAbsolute = utils.resolvePath(CONFIG_PATH);
  const args = [
    "--credentials", configAbsolute,
    "--port", "0",
    "--idle-timeout", String(HELPER_IDLE_TIMEOUT),
  ];
  utils.exec(helperBinary, args, null, (/** @type {string} */ chunk) => {
    String(chunk).split("\n").forEach(helperReadyFrame);
  }, (/** @type {string} */ chunk) => log.error(`helper: ${chunk}`)).then((result) => {
    helper.port = null;
    log.error(`helper exited (status ${result.status}): ${result.stderr}`);
  }, (error) => {
    helper.port = null;
    log.error(`helper launch failed: ${error}`);
  });
  // Wait for the READY frame.
  for (let waited = 0; waited < 5000 && !helper.port; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!helper.port) throw Object.assign(new Error("helper 未就绪"), { classification: "helper" });
  return helper.port;
}

// MARK: transport port over the loopback helper

function makeTransport() {
  return {
    /** @param {{path: string, body: any}} request */
    postJson: async (request) => {
      if (!helper.port) throw Object.assign(new Error("helper 未运行"), { code: "network" });
      try {
        const options = /** @type {any} */ ({ headers: { "Content-Type": "application/json" }, data: request.body });
        const response = await iina.http.post(`http://127.0.0.1:${helper.port}${request.path}`, options);
        let json = null;
        try {
          json = typeof response.data === "object" && response.data !== null ? response.data : JSON.parse(response.text);
        } catch {
          json = null;
        }
        // iina.http does not expose response headers, so Retry-After is
        // unavailable here and backoff falls back to its base rhythm.
        return { status: response.statusCode, retryAfter: null, json };
      } catch (error) {
        throw Object.assign(new Error(`loopback request failed: ${error}`), { code: "network" });
      }
    },
  };
}

// MARK: process port for extraction

function makeProcess() {
  return {
    /** @param {string} file @param {string[]} args @returns {Promise<{status: number, stdout: string, stderr: string}>} */
    run: async (file, args) => utils.exec(file, args),
  };
}

/** @param {PluginConfig} config @param {"ffmpeg" | "ffprobe"} kind */
/** Ensure the helper binary and tool paths; returns {ffmpeg, ffprobe, source}. */
/** @param {PluginConfig} config @returns {Promise<{ffmpeg: string, ffprobe: string, source: string}>} */
async function ensureTools(config) {
  const downloadedFfmpeg = utils.resolvePath(DOWNLOADED_FFMPEG);
  const downloadedFfprobe = utils.resolvePath(DOWNLOADED_FFPROBE);

  if (!config.ffmpegForceBundled) {
    const overrides = { ffmpeg: config.ffmpegPath || "", ffprobe: config.ffprobePath || "" };
    const ffmpegPick = await pickWorkingBinary(makeProcess(), candidatesFor(overrides, "ffmpeg", DOWNLOADED_FFMPEG));
    const ffprobePick = await pickWorkingBinary(makeProcess(), candidatesFor(overrides, "ffprobe", DOWNLOADED_FFPROBE));
    if (ffmpegPick.path && ffprobePick.path) {
      const source = ffmpegPick.path === downloadedFfmpeg || ffprobePick.path === downloadedFfprobe ? "downloaded" : "system";
      log.log(`tools: ${ffmpegPick.path} (${ffmpegPick.version}) / ${ffprobePick.path} (${ffprobePick.version}) [${source}]`);
      return { ffmpeg: ffmpegPick.path, ffprobe: ffprobePick.path, source };
    }
  }

  core.osd("未找到可用的 ffmpeg，正在下载内置最小构建…");
  await downloadTool(config, "ffmpeg");
  await downloadTool(config, "ffprobe");
  log.log(`tools downloaded: ${DOWNLOADED_FFMPEG}`);
  return { ffmpeg: utils.resolvePath(DOWNLOADED_FFMPEG), ffprobe: utils.resolvePath(DOWNLOADED_FFPROBE), source: "downloaded" };
}

/**
 * Download one tool binary into @data and make it executable. The download
 * base is a preference so packaging can point at the plugin's own release.
 * @param {PluginConfig} config @param {"ffmpeg" | "ffprobe"} tool @returns {Promise<void>}
 */
/** @param {PluginConfig} config @param {"ffmpeg" | "ffprobe"} tool @returns {Promise<void>} */
async function downloadTool(config, tool) {
  const base = config.ffmpegDownloadBaseUrl || DEFAULT_TOOL_DOWNLOAD_BASE;
  const dest = tool === "ffmpeg" ? DOWNLOADED_FFMPEG : DOWNLOADED_FFPROBE;
  // iina.http.download cannot carry binary payloads (Just's response content
  // is String-based and silently skips the write), so tools come down through
  // the system curl instead.
  const absolute = utils.resolvePath(dest);
  const download = await utils.exec("/usr/bin/curl", ["-fsSL", "-o", absolute, `${base}/${tool}`]);
  if (download.status !== 0) {
    throw Object.assign(new Error(`ffmpeg 下载失败（${tool}）：curl exit ${download.status} ${download.stderr}。请检查网络后重试。`), { classification: "network" });
  }
  if (!file.exists(dest)) {
    throw Object.assign(new Error(`ffmpeg 下载失败（${tool}）：文件未落盘。`), { classification: "network" });
  }
  const chmod = await utils.exec("/bin/chmod", ["+x", absolute]);
  if (chmod.status !== 0) throw new Error(`无法设置 ${tool} 的可执行权限。`);
  // Empirical record for the map: does a helper-downloaded binary carry the
  // com.apple.quarantine attribute?
  const xattr = await utils.exec("/usr/bin/xattr", ["-p", "com.apple.quarantine", utils.resolvePath(dest)]);
  log.log(`quarantine check for ${tool}: ${xattr.status === 0 ? "PRESENT" : "absent"} (${xattr.stderr || xattr.stdout || ""})`);
}

// MARK: engine

/** @type {any} */
let engine = null;
/** @param {PluginConfig} config */
function getEngine(config) {
  // Cheap to construct: rebuilt per run so preference changes (retries,
  // batch budget) always apply.
  engine = createEngine({
    storage: { ...storage, ...sizeTrackingStorage },
    transport: makeTransport(),
    maxBatchChars: config.maxBatchChars,
    maxRetries: config.maxRetries,
    glossaryPrecheck: true,
    shouldCancel: () => cancelRequested,
  });
  return engine;
}

// MARK: translation flow

/** @type {{ path: string, media: string, sourceId: number } | null} */
let pending = null;
let translating = false;
let cancelRequested = false;
let mode = "off"; // off | bilingual | translationOnly | paused
/** @type {Record<string, any>} */
const modeMenuItems = {};
/** @type {{ cacheKey: string, bilingualPath: string, translationOnlyPath: string, originalTrackId: number | null } | null} */
let lastVariants = null;
/** @type {number | null} */
let originalTrackId = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let deadline;

function clearPending() {
  pending = null;
  if (deadline !== undefined) clearTimeout(deadline);
  deadline = undefined;
}

function finishLoad() {
  if (!pending) return;
  const request = pending;
  if (mpv.getString("path") !== request.media) {
    clearPending();
    return;
  }
  // IINA's cached core tracks update after loadTrack returns. Match mpv's
  // actual external filename, never assume the new track has the largest id.
  const tracks = mpv.getNative("track-list");
  if (!Array.isArray(tracks)) return;
  const generated = tracks.find((track) =>
    track.type === "sub" && track.external === true &&
    track["external-filename"] === request.path && typeof track.id === "number");
  if (!generated) return;

  const selected = mpv.getNumber("sid");
  clearPending();
  if (selected !== request.sourceId && selected !== generated.id) {
    core.osd("已暂停：保留你选择的字幕轨。");
    return;
  }
  // Reloading an existing filename does not select it in IINA 1.4.4.
  core.subtitle.id = generated.id;
  core.osd("双语字幕已就绪。");
}

/** @param {any} error @returns {string} */
function failureMessage(error) {
  const classification = error && error.classification;
  switch (classification) {
    case "quota": return "API 额度不足或 key 无效，请检查配置。";
    case "timeout": return "上游服务超时（已自动重试与拆批）。";
    case "network": return "网络错误：无法连接翻译服务。";
    case "server": return "上游服务错误，请稍后重试。";
    default: return error instanceof Error ? error.message : String(error);
  }
}

/**
 * One-time migration: the pre-settings era stored everything in a hand-written
 * config.json. If preferences are unconfigured and that file exists, import it.
 * @param {PluginConfig} prefs
 * @returns {PluginConfig}
 */
function migrateLegacyConfig(prefs) {
  const configured = prefs.baseUrl && prefs.apiKey && prefs.model;
  if (configured || !file.exists(CONFIG_PATH)) return prefs;
  try {
    const legacy = JSON.parse(file.read(CONFIG_PATH, {}) || "{}");
    const importable = ["baseUrl", "apiKey", "model", "targetLanguage", "ffmpegPath", "ffprobePath", "helperPath"];
    /** @type {Record<string, any>} */
    const prefLike = /** @type {any} */ (prefs);
    let imported = false;
    for (const key of importable) {
      if (legacy[key] && !prefLike[key]) {
        preferences.set(key, legacy[key]);
        prefLike[key] = legacy[key];
        imported = true;
      }
    }
    if (imported) preferences.sync();
  } catch (error) {
    log.error(`legacy config migration failed: ${error}`);
  }
  return prefs;
}

/** @returns {PluginConfig} */
function readPrefs() {
  /** @param {string} key @param {any} fallback */
  const get = (key, fallback) => {
    const value = preferences.get(key);
    return value === undefined || value === null ? fallback : value;
  };
  return {
    baseUrl: String(get("baseUrl", "")),
    apiKey: String(get("apiKey", "")),
    model: String(get("model", "")),
    targetLanguage: String(get("targetLanguage", "zh-Hans")),
    defaultMode: String(get("defaultMode", "bilingual")),
    translationColor: String(get("translationColor", "#FFE580")),
    fontSizeRatio: Number(get("fontSizeRatio", 0.89)) || 0.89,
    lineOrder: String(get("lineOrder", "originalFirst")),
    autoTranslate: Boolean(get("autoTranslate", false)),
    maxRetries: get("maxRetries", 3) === null ? 3 : Number(get("maxRetries", 3)),
    translateHotkey: String(get("translateHotkey", "")),
    cacheLimitMB: Number(get("cacheLimitMB", 200)) || 200,
    clearCacheRequested: Number(get("clearCacheRequested", 0)) || 0,
    ffmpegPath: String(get("ffmpegPath", "")),
    ffprobePath: String(get("ffprobePath", "")),
    helperPath: String(get("helperPath", "")),
    ffmpegForceBundled: Boolean(get("ffmpegForceBundled", false)),
    ffmpegDownloadBaseUrl: String(get("ffmpegDownloadBaseUrl", "")),
  };
}

/**
 * The helper reads its credentials from this file; keep it in sync with the
 * preference values and locked to 0600. The key exists here and in IINA's
 * preference storage — nowhere else, and never in argv/env/logs.
 * @param {PluginConfig} config @returns {Promise<void>}
 */
async function syncHelperCredentials(config) {
  const payload = JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  file.write(CONFIG_PATH, payload);
  const chmod = await utils.exec("/bin/chmod", ["600", utils.resolvePath(CONFIG_PATH)]);
  if (chmod.status !== 0) {
    throw new Error("无法将凭据文件权限设为 0600，已中止翻译以保护 API key。");
  }
}

/** @param {PluginConfig} prefs @returns {import('./engine/assemble.js').AssemblyStyle} */
function styleFromPrefs(prefs) {
  return {
    translationColor: prefs.translationColor,
    fontSizeRatio: prefs.fontSizeRatio,
    lineOrder: prefs.lineOrder === "translationFirst" ? "translationFirst" : "originalFirst",
  };
}

/** Delete every cache artifact in the plugin data directory. */
function clearAllCacheFiles() {
  const entries = file.list("@data/", {}) || [];
  let removed = 0;
  for (const entry of entries) {
    const name = entry && entry.filename;
    if (typeof name === "string" && name.startsWith("cache-")) {
      try {
        file.delete(`@data/${name}`);
        removed += 1;
      } catch (error) {
        log.error(`cache delete failed for ${name}: ${error}`);
      }
    }
  }
  if (file.exists(LEDGER_PATH)) file.delete(LEDGER_PATH);
  return removed;
}

/** @param {PluginConfig} prefs */
function maybeProcessCacheClearRequest(prefs) {
  if (!prefs || !prefs.clearCacheRequested) return;
  const markerPath = "@data/.cache-clear-marker";
  const marker = file.exists(markerPath) ? Number(file.read(markerPath, {}) || 0) : 0;
  if (prefs.clearCacheRequested > marker) {
    const removed = clearAllCacheFiles();
    file.write(markerPath, String(prefs.clearCacheRequested));
    core.osd(`已清除缓存（${removed} 个文件）。`);
  }
}

const LEDGER_PATH = "@data/cache-ledger.json";

/** UTF-8 byte length without TextEncoder (JSC-safe). @param {string} text @returns {number} */
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbfff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

/** @returns {{order: string[], keys: Record<string, {order: string[], sizes: Record<string, number>}>}} */
function readLedger() {
  if (!file.exists(LEDGER_PATH)) return { order: [], keys: {} };
  try {
    const ledger = JSON.parse(file.read(LEDGER_PATH, {}) || "{}");
    if (!ledger.keys || typeof ledger.keys !== "object" || !Array.isArray(ledger.order)) {
      return { order: [], keys: {} }; // pre-MAR-99 flat ledger or garbage: reset
    }
    return { order: ledger.order, keys: ledger.keys };
  } catch (error) {
    log.error(`cache ledger unreadable, resetting: ${error}`);
    return { order: [], keys: {} };
  }
}

/** @param {{order: string[], keys: Record<string, {order: string[], sizes: Record<string, number>}>}} ledger */
function writeLedger(ledger) {
  file.write(LEDGER_PATH, JSON.stringify(ledger));
}

/**
 * Ledger groups all artifacts of one cache key, so eviction always removes a
 * key's variants + translations together — a later cache hit can never
 * resurrect entries from a surviving half.
 * @param {string} key @param {string} path @param {number} size
 */
function ledgerAdd(key, path, size) {
  const ledger = readLedger();
  const group = ledger.keys[key] || (ledger.keys[key] = { order: [], sizes: {} });
  if (group.sizes[path] === undefined) group.order.push(path);
  group.sizes[path] = size;
  if (!ledger.order.includes(key)) ledger.order.push(key);
  writeLedger(ledger);
}

/** @param {string} key */
function ledgerRemoveKey(key) {
  const ledger = readLedger();
  const group = ledger.keys[key];
  if (!group) return;
  for (const path of group.order) {
    try {
      if (file.exists(`@data/${path}`)) file.delete(`@data/${path}`);
    } catch (error) {
      log.error(`cache delete failed for ${path}: ${error}`);
    }
  }
  delete ledger.keys[key];
  ledger.order = ledger.order.filter((entry) => entry !== key);
  writeLedger(ledger);
}

/** Track every cache artifact's size as it is written. */
const sizeTrackingStorage = {
  /** @param {string} key @param {any} record @returns {Promise<void>} */
  put: async (key, record) => {
    for (const part of [record.bilingual, record.translationOnly]) {
      file.write(`@data/${part.path}`, part.content);
      ledgerAdd(key, part.path, utf8Length(part.content));
    }
  },
  /** @param {string} key @param {string[]} translations */
  putTranslations: async (key, translations) => {
    const path = translationsPath(key);
    const content = JSON.stringify(translations);
    file.write(`@data/${path}`, content);
    ledgerAdd(key, path, utf8Length(content));
  },
};

/** @param {PluginConfig} prefs */
function enforceCacheLimit(prefs) {
  const limitBytes = (prefs.cacheLimitMB || 200) * 1024 * 1024;
  const ledger = readLedger();
  let total = 0;
  for (const key of ledger.order) {
    const group = ledger.keys[key];
    if (!group) continue;
    for (const size of Object.values(group.sizes)) total += size;
  }
  for (const key of ledger.order.slice()) {
    if (total <= limitBytes) break;
    const group = ledger.keys[key];
    if (!group) continue;
    for (const path of group.order) total -= group.sizes[path] || 0;
    ledgerRemoveKey(key);
  }
}

/**
 * @param {number} trackId
 * @param {{silent?: boolean}} [options]
 */
async function translateTrackById(trackId, options) {
  await translateCurrentSubtitle({ ...options, trackId });
}

/** @returns {PluginConfig | null} */
function loadConfig() {
  return migrateLegacyConfig(readPrefs());
}

/**
 * @param {{silent?: boolean, trackId?: number}} [options]
 */
async function translateCurrentSubtitle(options) {
  const { silent = false, trackId } = options || {};
  let config = null;
  try {
    if (pending || translating) {
      if (!silent) core.osd("正在加载双语字幕，请稍候。");
      return;
    }
    translating = true;
    config = migrateLegacyConfig(readPrefs());
    maybeProcessCacheClearRequest(config);
    if (!config.baseUrl || !config.apiKey || !config.model) {
      if (!silent) core.osd("请先在 设置 → 插件 → LLM Subtitle Prototype 中配置 LLM 服务。");
      return;
    }
    await syncHelperCredentials(config);

    const media = mpv.getString("path");
    const track = trackId !== undefined
      ? core.subtitle.tracks.find((t) => t.id === trackId)
      : core.subtitle.currentTrack;
    if (!media || !track) {
      if (!silent) core.osd("请先打开视频并选中一条字幕轨。");
      return;
    }
    const source = track.isExternal ? utils.resolvePath(`@sub/${track.id}`) : null;

    /** @type {{format: "srt" | "ass", content: string}} */
    let subtitle;
    if (source && /\.(srt)$/i.test(source)) {
      const text = file.read(source, {});
      if (typeof text !== "string") throw new Error("无法读取 SRT 字幕文件。");
      subtitle = { format: "srt", content: text };
    } else if (source && /\.(ass|ssa)$/i.test(source)) {
      const text = file.read(source, {});
      if (typeof text !== "string") throw new Error("无法读取 ASS 字幕文件。");
      subtitle = { format: "ass", content: text };
    } else if (!track.isExternal) {
      // Embedded container track: extract via ffmpeg (container index from
      // mpv's track-list `ff-index`).
      const tools = await ensureTools(config);
      const ffmpeg = tools.ffmpeg;
      const ffprobe = tools.ffprobe;
      const trackList = mpv.getNative("track-list");
      const mpvTrack = Array.isArray(trackList)
        ? trackList.find((t) => t.type === "sub" && t.id === track.id)
        : null;
      const containerIndex = mpvTrack && typeof mpvTrack["ff-index"] === "number" ? mpvTrack["ff-index"] : track.id - 1;
      const tracks = await listSubtitleTracks(makeProcess(), { ffprobe, media });
      const probed = tracks.find((t) => t.index === containerIndex);
      if (!probed) throw new Error(`未在容器中找到字幕轨（索引 ${containerIndex}）。`);
      const extracted = await extractTrackToText(makeProcess(), { ffmpeg, media, track: probed });
      subtitle = { format: extracted.format, content: extracted.content };
    } else {
      core.osd("选中的外挂字幕格式不受支持（仅 SRT / ASS / 内嵌文本轨）。");
      return;
    }

    const port = await ensureHelper(config);
    log.log(`translating via 127.0.0.1:${port}`);
    const result = await getEngine(config).translateTrack(subtitle, {
      model: config.model,
      targetLanguage: config.targetLanguage,
      style: styleFromPrefs(config),
    }, {
      onProgress: (/** @type {any} */ event) => {
        sidebarPost("progress", { phase: event.phase, done: event.done, total: event.total });
        if (event.phase === "translation") core.osd(`翻译中 ${event.done}/${event.total} 批…`);
        else if (event.phase === "assembly") core.osd("正在装配双语字幕…");
      },
    });
    if (!result.bilingual || !result.translationOnly) throw new Error("翻译结果不完整。");
    lastVariants = {
      cacheKey: result.cacheKey,
      bilingualPath: utils.resolvePath(`@data/${result.bilingual.path}`),
      translationOnlyPath: utils.resolvePath(`@data/${result.translationOnly.path}`),
      originalTrackId: track.id,
    };
    originalTrackId = track.id;
    const chosen = config.defaultMode === "translationOnly" ? result.translationOnly : result.bilingual;
    const absolute = utils.resolvePath(`@data/${chosen.path}`);
    if (!absolute || !file.exists(`@data/${chosen.path}`)) throw new Error("双语字幕文件写入失败。");
    core.osd(result.cacheHit ? "缓存命中：直接加载已翻译的双语字幕。" : "双语字幕翻译完成。");
    mode = config.defaultMode === "translationOnly" ? "translationOnly" : "bilingual";
    translating = false;
    enforceCacheLimit(config);

    pending = { path: absolute, media, sourceId: track.id };
    deadline = setTimeout(() => {
      clearPending();
      core.osd("IINA 未确认字幕轨加载。请查看插件开发者工具中的错误日志。");
      log.error("generated ASS was not found in mpv track-list after loadTrack.");
    }, 3000);
    core.subtitle.loadTrack(absolute);
    // Also handles reloading a previously generated track, which may not
    // produce a track-list change. Defer out of the native menu callback.
    setTimeout(finishLoad, 0);
  } catch (/** @type {unknown} */ error) {
    clearPending();
    translating = false;
    sidebarPost("state", { view: "error", cancelled: cancelRequested, errorMessage: failureMessage(error) });
    cancelRequested = false;
    const message = failureMessage(error);
    const err = /** @type {any} */ (error);
    log.error(`translate failed: ${err && err.stack ? err.stack : err}`);
    try {
      file.write("@data/last-error.txt", `${new Date().toISOString()}\n${err && err.name ? err.name : "?"}: ${err && err.message ? err.message : String(err)}\n${err && err.stack ? err.stack : ""}\n`);
    } catch { /* diagnostics only */ }
    if (!silent) core.osd(`翻译失败：${message}`);
  }
}

event.on("mpv.track-list.changed", () => {
  if (pending) setTimeout(finishLoad, 0);
});
event.on("iina.file-started", clearPending);
event.on("iina.file-loaded", () => {
  setTimeout(async () => {
    try {
      /** @type {PluginConfig} */
      const prefs = readPrefs();
      maybeProcessCacheClearRequest(prefs);
      const loaded = await loadCachedIfAvailable();
      if (loaded) return;
      if (prefs.autoTranslate) {
        const track = core.subtitle.currentTrack;
        if (track) translateTrackById(track.id, { silent: true });
      }
    } catch (error) {
      log.error(`auto-translate failed: ${error}`);
    }
  }, 800);
});
setInterval(() => {
  try {
    maybeProcessCacheClearRequest(/** @type {PluginConfig} */ (readPrefs()));
  } catch (error) {
    log.error(`cache-clear check failed: ${error}`);
  }
}, 30000);
// MARK: sidebar (progress / cancel / resume)

/** @param {string} name @param {any} data */
function sidebarPost(name, data) {
  try {
    iina.sidebar.postMessage(name, data);
  } catch (error) {
    log.error(`sidebar post failed: ${error}`);
  }
}
// Deferred: activating the sidebar webview synchronously at entry load
// raced IINA's plugin registration on some launches.
setTimeout(() => {
  try {
    const sb = iina.sidebar;
    sb.loadFile("sidebar.html");
    sb.show();
    sb.onMessage("cancel", () => {
      cancelRequested = true;
    });
    sb.onMessage("resume", () => {
      translateCurrentSubtitle({ silent: false });
    });
    sb.onMessage("giveup", () => {
      cancelRequested = false;
      translating = false;
      sidebarPost("state", { view: "error", cancelled: true, errorMessage: "" });
      core.osd("已放弃：中间态已保留，可随时继续。");
    });
  } catch (error) {
    log.error(`sidebar init failed: ${error}`);
  }
}, 500);

// MARK: cache-hit auto-load on file load

async function loadCachedIfAvailable() {
  const config = loadConfig();
  if (!config) return false;
  const track = core.subtitle.currentTrack;
  if (!track) return false;
  let subtitle;
  if (track.isExternal) {
    const source = utils.resolvePath(`@sub/${track.id}`);
    if (!source || !/\.(srt|ass|ssa)$/i.test(source)) return false;
    const text = file.read(source, {});
    if (typeof text !== "string") return false;
    subtitle = { format: /\.(ass|ssa)$/i.test(source) ? "ass" : "srt", content: text };
  } else {
    const tools = await ensureTools(config);
    const trackList = mpv.getNative("track-list");
    const mpvTrack = Array.isArray(trackList) ? trackList.find((t) => t.type === "sub" && t.id === track.id) : null;
    const containerIndex = mpvTrack && typeof mpvTrack["ff-index"] === "number" ? mpvTrack["ff-index"] : track.id - 1;
    const tracks = await listSubtitleTracks(makeProcess(), { ffprobe: tools.ffprobe, media: mpv.getString("path") });
    const probed = tracks.find((t) => t.index === containerIndex);
    if (!probed || probed.kind !== "text") return false;
    const extracted = await extractTrackToText(makeProcess(), { ffmpeg: tools.ffmpeg, media: mpv.getString("path"), track: probed });
    subtitle = { format: extracted.format, content: extracted.content };
  }
  /** @type {import("./engine/index.js").Cue[]} */
  const cues = parseSubtitle(/** @type {"srt" | "ass"} */ (subtitle.format), subtitle.content);
  const key = require("./engine/cache.js").buildCacheKey(
    cues.map((cue) => `${cue.startMs}\u0000${cue.endMs}\u0000${cue.text}`).join("\u0001"),
    { model: config.model, targetLanguage: config.targetLanguage || "zh-Hans" },
  );
  const paths = variantPaths(key);
  if (!file.exists(`@data/${paths.bilingual}`)) return false;
  lastVariants = {
    cacheKey: key,
    bilingualPath: utils.resolvePath(`@data/${paths.bilingual}`) || "",
    translationOnlyPath: utils.resolvePath(`@data/${paths.translationOnly}`) || "",
    originalTrackId: track.id,
  };
  originalTrackId = track.id;
  const prefs = readPrefs();
  applyMode(prefs.defaultMode === "translationOnly" ? "translationOnly" : "bilingual");
  core.osd("缓存命中：已加载双语字幕。");
  return true;
}

// Menu items cannot be removed once added, so the hotkey preference applies
// on the next IINA launch.
(function buildMenu() {
  const prefs = readPrefs();
  menu.addItem(menu.item("翻译字幕（当前轨）", () => {
    const track = core.subtitle.currentTrack;
    if (track) translateTrackById(track.id);
  }, prefs.translateHotkey ? { keyBinding: prefs.translateHotkey } : undefined));

  // Track selector: text tracks translate; bitmap tracks are listed but
  // disabled with an OCR explanation.
  const selectorMenu = menu.item("翻译指定字幕轨…", () => {});
  let selectable = 0;
  for (const track of core.subtitle.tracks) {
    const bitmap = /^(hdmv_pgs_subtitle|dvd_subtitle|dvb_subtitle|dvb_teletext|arib_caption)$/.test(track.codec || "");
    const label = `#${track.id} ${track.title || track.formattedTitle}`;
    if (bitmap) {
      selectorMenu.addSubMenuItem(menu.item(label + " — 图像字幕需 OCR，暂不支持", () => {}, { enabled: false }));
    } else {
      selectable += 1;
      selectorMenu.addSubMenuItem(menu.item(label, () => {
        translateTrackById(track.id);
      }));
    }
  }
  menu.addItem(selectorMenu);

  const modeItem = menu.item("字幕模式", () => {});
  modeMenuItems.bilingual = menu.item("双语", () => {
      applyMode("bilingual");
    }, { selected: mode === "bilingual" });
  modeMenuItems.translationOnly = menu.item("仅译文", () => {
      applyMode("translationOnly");
    }, { selected: mode === "translationOnly" });
  modeMenuItems.off = menu.item("关闭翻译字幕", () => {
      applyMode("off");
    }, { selected: mode === "off" });
  for (const item of Object.values(modeMenuItems)) modeItem.addSubMenuItem(item);
  menu.addItem(modeItem);

  menu.addItem(menu.item("取消翻译", () => {
    cancelRequested = true;
    core.osd("正在取消…");
  }));
})();

/** @param {string} nextMode */
function applyMode(nextMode) {
  mode = nextMode;
  for (const key of Object.keys(modeMenuItems)) {
    modeMenuItems[key].selected = key === nextMode;
  }
  if (nextMode === "off") {
    if (originalTrackId) core.subtitle.id = originalTrackId;
    core.osd("已关闭翻译字幕。");
    return;
  }
  if (!lastVariants) {
    core.osd("尚无已翻译的双语字幕。");
    return;
  }
  const target = nextMode === "translationOnly" ? lastVariants.translationOnlyPath : lastVariants.bilingualPath;
  core.subtitle.loadTrack(target);
  core.osd(nextMode === "bilingual" ? "双语字幕。" : "仅译文模式。");
}

} catch (/** @type {any} */ loadError) {
  const msg = (loadError && loadError.message) || String(loadError);
  const stack = loadError && loadError.stack ? String(loadError.stack) : "";
  try {
    iina.file.write("@data/load-error.txt", `${new Date().toISOString()}\n${msg}\n${stack}\n`);
  } catch {}
  if (typeof iina.console !== "undefined") iina.console.error(`entry load failed: ${msg}\n${stack}`);
}
