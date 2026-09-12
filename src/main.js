"use strict";

try {

const { createEngine, variantPaths, parseSubtitle } = require("./engine/index.js");
const { createJobTransport } = require("./helper-client.js");
const { listSubtitleTracks, extractTrackToText } = require("./engine/extract.js");
const { pickWorkingBinary, candidatesFor } = require("./engine/ffmpeg.js");
// NOTE: iina.sidebar is accessed lazily (see deferred init below) — touching
// the getter at entry load crashes IINA 1.4.4 (EXC_BREAKPOINT in
// JavascriptPolyfill.register).
const { core, menu, file, utils, mpv, event, http, preferences, console: log } = iina;

const DOWNLOADED_FFMPEG = "@data/bin-ffmpeg";
const DOWNLOADED_FFPROBE = "@data/bin-ffprobe";
const DEFAULT_TOOL_DOWNLOAD_BASE = "https://github.com/Xy2002/iina-llm-subtitle/releases/latest/download";

/**
 * @typedef {{
 *   baseUrl: string,
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

// MARK: shared helper connection

/** @type {Map<string, {resolve: (value: any) => void, reject: (error: Error) => void, timer: string}>} */
const helperRequests = new Map();
let helperSequence = 0;
const helperRequestPrefix = Math.random().toString(36).slice(2);
iina.global.onMessage("helper-response", (response) => {
  const request = response && helperRequests.get(response.id);
  if (!request) return;
  helperRequests.delete(response.id);
  clearTimeout(request.timer);
  if (response.error) request.reject(new Error(response.error));
  else request.resolve(response);
});

/** @param {PluginConfig} config @returns {Promise<import('./helper-client.js').HelperConnection>} */
async function ensureHelper(config) {
  const result = await new Promise((resolve, reject) => {
    const id = `${helperRequestPrefix}-${++helperSequence}`;
    const timer = setTimeout(() => {
      helperRequests.delete(id);
      reject(new Error("翻译助手未就绪，请重试。"));
    }, 10000);
    helperRequests.set(id, { resolve, reject, timer });
    iina.global.postMessage("helper-request", { id, baseUrl: config.baseUrl });
  });
  if (!result.configured) throw Object.assign(new Error("请先在插件设置中设置 API Key。"), { classification: "config" });
  return result.connection;
}

// One transport per entry load: the pending-job registry must outlive a run,
// so a resumed run waits on the same uncertain job instead of submitting the
// same paid request under a new id after the previous run gave up on it.
// The clock port is threaded from this entry so tests can simulate backoff.
const jobTransport = createJobTransport({
  http,
  getConnection: () => ensureHelper(readPrefs()),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

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
    const ffmpegPick = await pickWorkingBinary(makeProcess(), candidatesFor(overrides, "ffmpeg", downloadedFfmpeg));
    const ffprobePick = await pickWorkingBinary(makeProcess(), candidatesFor(overrides, "ffprobe", downloadedFfprobe));
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

// MARK: translation state

/** @typedef {{generation: number, media: string, cancelled: boolean}} TranslationRun */
/** @type {TranslationRun | null} */
let activeRun = null;
let mediaGeneration = 0;
/** @type {number | null} */
let deferredAutoGeneration = null;
let mode = "off";
/** @type {Record<string, any>} */
const modeMenuItems = {};
/** @type {{media: string, generation: number, cacheKey: string, bilingualPath: string, translationOnlyPath: string, originalTrackId: number} | null} */
let lastVariants = null;
/** @type {number | null} */
let originalTrackId = null;
/** @type {number | null} */
let resumeTrackId = null;
/** @type {{path: string, media: string, generation: number, expectedSid: number, nextMode: string} | null} */
let pending = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let deadline;
/** @type {any} */
let sidebarState = { view: "idle", phase: "", done: 0, total: 0, cancelled: false, errorMessage: "" };

/** @param {TranslationRun} run */
function isCurrentRun(run) {
  return run.generation === mediaGeneration && mpv.getString("path") === run.media;
}

/** @param {PluginConfig} config @param {TranslationRun} run */
function getEngine(config, run) {
  return createEngine({
    storage: { ...storage, ...sizeTrackingStorage },
    transport: jobTransport,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxBatchChars: config.maxBatchChars,
    maxRetries: config.maxRetries,
    glossaryPrecheck: true,
    shouldCancel: () => run.cancelled || !isCurrentRun(run),
  });
}

function clearPending() {
  pending = null;
  if (deadline !== undefined) clearTimeout(deadline);
  deadline = undefined;
}

/** @param {string} nextMode */
function selectModeMenu(nextMode) {
  mode = nextMode;
  for (const key of Object.keys(modeMenuItems)) modeMenuItems[key].selected = key === mode;
}

function finishLoad() {
  if (!pending) return;
  const request = pending;
  if (mpv.getString("path") !== request.media || request.generation !== mediaGeneration) {
    clearPending();
    return;
  }
  const tracks = mpv.getNative("track-list");
  if (!Array.isArray(tracks)) return;
  const generated = tracks.find((track) => track.type === "sub" && track.external === true &&
    track["external-filename"] === request.path && typeof track.id === "number");
  if (!generated) return;
  const selected = mpv.getNumber("sid");
  clearPending();
  if (selected !== request.expectedSid && selected !== generated.id) {
    selectModeMenu("paused");
    sidebarPost("state", { view: "completed", done: 1, total: 1 });
    core.osd("已暂停：保留你选择的字幕轨。可从字幕模式菜单重新加载。");
    return;
  }
  core.subtitle.id = generated.id;
  selectModeMenu(request.nextMode);
  sidebarPost("state", { view: "completed", done: 1, total: 1 });
  core.osd(request.nextMode === "translationOnly" ? "仅译文字幕已就绪。" : "双语字幕已就绪。");
}

/** @param {string} path @param {string} nextMode @param {number} [expectedSid] */
function loadVariant(path, nextMode, expectedSid) {
  if (!lastVariants || lastVariants.media !== mpv.getString("path") || lastVariants.generation !== mediaGeneration) return;
  clearPending();
  pending = { path, media: lastVariants.media, generation: mediaGeneration,
    expectedSid: expectedSid === undefined ? mpv.getNumber("sid") : expectedSid, nextMode };
  deadline = setTimeout(() => {
    clearPending();
    core.osd("IINA 未确认字幕轨加载。请重试。");
  }, 3000);
  core.subtitle.loadTrack(path);
  setTimeout(finishLoad, 0);
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

/** @returns {PluginConfig} */
function readPrefs() {
  /** @param {string} key @param {any} fallback */
  const get = (key, fallback) => {
    const value = preferences.get(key);
    return value === undefined || value === null ? fallback : value;
  };
  return {
    baseUrl: String(get("baseUrl", "")),
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
    if (lastVariants && key === lastVariants.cacheKey) continue;
    const group = ledger.keys[key];
    if (!group) continue;
    for (const path of group.order) total -= group.sizes[path] || 0;
    ledgerRemoveKey(key);
  }
}

/** @param {number} trackId @param {{silent?: boolean}} [options] */
async function translateTrackById(trackId, options) {
  await translateCurrentSubtitle({ ...options, trackId });
}

/** @param {any} track @param {PluginConfig} config @param {string} media
 * @returns {Promise<{format: "srt" | "ass", content: string}>} */
async function readSubtitle(track, config, media) {
  if (track.isExternal) {
    const source = utils.resolvePath(`@sub/${track.id}`);
    if (!source || !/\.(srt|ass|ssa)$/i.test(source)) throw new Error("选中的外挂字幕格式不受支持（仅 SRT / ASS）。");
    const content = file.read(source, {});
    if (typeof content !== "string") throw new Error("无法读取字幕文件。");
    return { format: /\.(ass|ssa)$/i.test(source) ? "ass" : "srt", content };
  }
  const tools = await ensureTools(config);
  const trackList = mpv.getNative("track-list");
  const mpvTrack = Array.isArray(trackList) ? trackList.find((t) => t.type === "sub" && t.id === track.id) : null;
  const containerIndex = mpvTrack && typeof mpvTrack["ff-index"] === "number" ? mpvTrack["ff-index"] : -1;
  const tracks = await listSubtitleTracks(makeProcess(), { ffprobe: tools.ffprobe, media });
  const probed = tracks.find((t) => t.index === containerIndex);
  if (!probed) throw new Error("未能确定容器中的字幕轨，请重新选择字幕后重试。");
  const extracted = await extractTrackToText(makeProcess(), { ffmpeg: tools.ffmpeg, media, track: probed });
  return { format: extracted.format, content: extracted.content };
}

/** @param {{silent?: boolean, trackId?: number}} [options] */
async function translateCurrentSubtitle(options) {
  const { silent = false, trackId } = options || {};
  if (pending || activeRun) {
    if (!silent) core.osd(activeRun && activeRun.cancelled ? "正在结束当前批次，请稍候。" : "正在翻译或加载字幕，请稍候。");
    return;
  }
  const run = { generation: mediaGeneration, media: mpv.getString("path"), cancelled: false };
  activeRun = run;
  try {
    const config = readPrefs();
    maybeProcessCacheClearRequest(config);
    if (!config.baseUrl || !config.model) {
      if (!silent) core.osd("请先在插件设置中配置 LLM 服务地址和模型。");
      return;
    }
    const track = trackId !== undefined ? core.subtitle.tracks.find((t) => t.id === trackId) : core.subtitle.currentTrack;
    if (!run.media || !track) {
      if (!silent) core.osd("请先打开视频并选中一条字幕轨。");
      return;
    }
    resumeTrackId = track.id;
    const expectedSid = mpv.getNumber("sid");
    sidebarPost("state", { view: "running", phase: "extraction", done: 0, total: 1, cancelled: false, errorMessage: "" });
    const subtitle = await readSubtitle(track, config, run.media);
    if (!isCurrentRun(run) || run.cancelled) {
      if (isCurrentRun(run)) sidebarPost("state", { view: "error", cancelled: true, errorMessage: "" });
      return;
    }
    const result = await getEngine(config, run).translateTrack(subtitle, {
      model: config.model, targetLanguage: config.targetLanguage || "zh-Hans", style: styleFromPrefs(config),
    }, {
      onProgress: (/** @type {any} */ progress) => {
        if (!isCurrentRun(run)) return;
        const done = progress.linesDone === undefined ? progress.done : progress.linesDone;
        const total = progress.linesTotal === undefined ? progress.total : progress.linesTotal;
        sidebarPost("progress", { phase: progress.phase, done, total });
      },
    });
    if (!isCurrentRun(run)) return;
    if (run.cancelled || result.status === "cancelled") {
      sidebarPost("state", { view: "error", cancelled: true, errorMessage: "" });
      if (!silent) core.osd("已取消，已完成的批次已保留，可继续翻译。");
      return;
    }
    if (!result.bilingual || !result.translationOnly) throw new Error("翻译结果不完整。");
    lastVariants = {
      media: run.media, generation: run.generation, cacheKey: result.cacheKey,
      bilingualPath: utils.resolvePath(`@data/${result.bilingual.path}`),
      translationOnlyPath: utils.resolvePath(`@data/${result.translationOnly.path}`), originalTrackId: track.id,
    };
    originalTrackId = track.id;
    const nextMode = config.defaultMode === "translationOnly" ? "translationOnly" : "bilingual";
    const chosen = nextMode === "translationOnly" ? result.translationOnly : result.bilingual;
    if (!file.exists(`@data/${chosen.path}`)) throw new Error("字幕文件写入失败。");
    enforceCacheLimit(config);
    if (mpv.getNumber("sid") !== expectedSid) {
      selectModeMenu("paused");
      sidebarPost("state", { view: "completed" });
      core.osd("翻译已完成，保留你选择的字幕轨。可从字幕模式菜单加载译文。");
      return;
    }
    loadVariant(utils.resolvePath(`@data/${chosen.path}`), nextMode, expectedSid);
  } catch (error) {
    if (!isCurrentRun(run)) return;
    clearPending();
    const message = failureMessage(error);
    sidebarPost("state", { view: "error", cancelled: run.cancelled, errorMessage: message });
    if (!silent) core.osd(`翻译失败：${message}`);
  } finally {
    if (activeRun === run) {
      activeRun = null;
      if (deferredAutoGeneration === mediaGeneration) {
        const generation = deferredAutoGeneration;
        deferredAutoGeneration = null;
        setTimeout(() => {
          if (generation === mediaGeneration && readPrefs().autoTranslate) translateCurrentSubtitle({ silent: true });
        }, 0);
      }
    }
  }
}

event.on("mpv.track-list.changed", () => {
  if (pending) setTimeout(finishLoad, 0);
});
event.on("iina.file-started", () => {
  mediaGeneration += 1;
  deferredAutoGeneration = null;
  if (activeRun) activeRun.cancelled = true;
  clearPending();
  lastVariants = null;
  originalTrackId = null;
  resumeTrackId = null;
  selectModeMenu("off");
  sidebarPost("state", { view: "idle", phase: "", done: 0, total: 0, cancelled: false, errorMessage: "" });
});
event.on("iina.file-loaded", () => {
  const generation = mediaGeneration;
  setTimeout(async () => {
    if (generation !== mediaGeneration) return;
    try {
      const prefs = readPrefs();
      maybeProcessCacheClearRequest(prefs);
      const loaded = await loadCachedIfAvailable();
      if (generation !== mediaGeneration || loaded) return;
      if (prefs.autoTranslate) {
        if (activeRun && !isCurrentRun(activeRun)) { deferredAutoGeneration = generation; return; }
        const track = core.subtitle.currentTrack;
        if (track) await translateTrackById(track.id, { silent: true });
      }
    } catch (error) { log.error(`auto-load failed: ${failureMessage(error)}`); }
  }, 800);
});
setInterval(() => {
  if (!activeRun && !pending) maybeProcessCacheClearRequest(readPrefs());
}, 30000);

// MARK: sidebar

/** @param {string} name @param {any} data */
function sidebarPost(name, data) {
  sidebarState = { ...sidebarState, ...data, ...(name === "progress" ? { view: "running" } : {}) };
  try { iina.sidebar.postMessage(name, data); } catch { /* the WebView may still be loading */ }
}
function cancelTranslation() {
  if (!activeRun) return;
  activeRun.cancelled = true;
  core.osd("正在取消，等待当前批次结束并保存。");
}
setTimeout(() => {
  try {
    const sb = iina.sidebar;
    sb.loadFile("sidebar.html");
    sb.onMessage("ready", () => sb.postMessage("state", sidebarState));
    sb.onMessage("cancel", cancelTranslation);
    sb.onMessage("resume", () => translateCurrentSubtitle({ trackId: resumeTrackId === null ? undefined : resumeTrackId }));
    sb.onMessage("giveup", () => {
      if (activeRun) activeRun.cancelled = true;
      sidebarPost("state", { view: "idle", cancelled: false, errorMessage: "" });
      core.osd("中间结果已保留，可稍后继续。");
    });
  } catch (error) { log.error(`sidebar init failed: ${failureMessage(error)}`); }
}, 500);

// MARK: cache-hit auto-load on file load

async function loadCachedIfAvailable() {
  const config = readPrefs();
  const track = core.subtitle.currentTrack;
  const media = mpv.getString("path");
  if (!track || !media || !config.model) return false;
  const run = { generation: mediaGeneration, media, cancelled: false };
  const expectedSid = mpv.getNumber("sid");
  const subtitle = await readSubtitle(track, config, media);
  if (!isCurrentRun(run)) return false;
  const cues = parseSubtitle(subtitle.format, subtitle.content);
  const key = require("./engine/cache.js").buildCacheKey(
    cues.map((cue) => `${cue.startMs}\u0000${cue.endMs}\u0000${cue.text}`).join("\u0001"),
    { model: config.model, targetLanguage: config.targetLanguage || "zh-Hans" },
  );
  if (!await storage.getTranslations(key)) return false;
  const result = await getEngine(config, run).translateTrack(subtitle, {
    model: config.model, targetLanguage: config.targetLanguage || "zh-Hans", style: styleFromPrefs(config),
  });
  if (!isCurrentRun(run) || !result.bilingual || !result.translationOnly) return false;
  lastVariants = {
    media, generation: run.generation, cacheKey: key,
    bilingualPath: utils.resolvePath(`@data/${result.bilingual.path}`),
    translationOnlyPath: utils.resolvePath(`@data/${result.translationOnly.path}`), originalTrackId: track.id,
  };
  originalTrackId = track.id;
  if (mpv.getNumber("sid") !== expectedSid) { selectModeMenu("paused"); return true; }
  applyMode(config.defaultMode === "translationOnly" ? "translationOnly" : "bilingual");
  core.osd("缓存命中：已加载翻译字幕。");
  return true;
}

// Bind the hotkey when this player instance creates its plugin menu.
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

  menu.addItem(menu.item("取消翻译", cancelTranslation));
  menu.addItem(menu.item("设置 API Key…", () => {
    preferences.set("credentialsEditRequested", Date.now());
  }));
})();

/** @param {string} nextMode */
function applyMode(nextMode) {
  clearPending();
  if (nextMode === "off") {
    if (originalTrackId !== null && core.subtitle.tracks.some((track) => track.id === originalTrackId)) core.subtitle.id = originalTrackId;
    selectModeMenu("off");
    core.osd("已关闭翻译字幕。");
    return;
  }
  if (!lastVariants || lastVariants.media !== mpv.getString("path") || lastVariants.generation !== mediaGeneration) {
    core.osd("尚无已翻译的字幕。");
    return;
  }
  const target = nextMode === "translationOnly" ? lastVariants.translationOnlyPath : lastVariants.bilingualPath;
  loadVariant(target, nextMode);
}

} catch (/** @type {any} */ loadError) {
  const msg = (loadError && loadError.message) || String(loadError);
  const stack = loadError && loadError.stack ? String(loadError.stack) : "";
  try {
    iina.file.write("@data/load-error.txt", `${new Date().toISOString()}\n${msg}\n${stack}\n`);
  } catch {}
  if (typeof iina.console !== "undefined") iina.console.error(`entry load failed: ${msg}\n${stack}`);
}
