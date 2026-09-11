"use strict";

const { sha256Hex } = require("./sha256.js");

/**
 * Cache identity per the map's decision: subtitle content hash + model +
 * target language + pipeline version salt. The salt (a build-time constant)
 * invalidates every cached translation when translation logic changes.
 */
const PIPELINE_VERSION = "1";

/**
 * @param {string} normalizedSubtitleContent
 * @param {{model: string, targetLanguage: string}} parts
 * @returns {string}
 */
function buildCacheKey(normalizedSubtitleContent, parts) {
  const identity = JSON.stringify({
    content: sha256Hex(normalizedSubtitleContent),
    model: parts.model,
    targetLanguage: parts.targetLanguage,
    pipelineVersion: PIPELINE_VERSION,
  });
  return sha256Hex(identity);
}

module.exports = { buildCacheKey, PIPELINE_VERSION };
