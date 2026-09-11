"use strict";
// Minimal OpenAI-compatible mock for end-to-end wiring tests without a real
// API key: speaks the /v1/chat/completions shape (glossary + translate
// purposes) over http://127.0.0.1:19009/v1.
const http = require("node:http");

function contextOf(body) {
  return JSON.parse(body.messages[1].content);
}

http.createServer((req, res) => {
  if (req.url.startsWith("/bin/")) {
    const tool = req.url.endsWith("ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/opt/homebrew/bin/ffmpeg";
    try {
      const bytes = require("node:fs").readFileSync(tool);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(bytes);
      console.error(`served ${tool} (${bytes.length} bytes)`);
    } catch (error) {
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const context = JSON.parse(body.messages[1].content);
    console.error("PURPOSE:", context.purpose, "| cues:", (context.cues || []).length);
    const content = context.purpose === "glossary"
      ? JSON.stringify({ glossary: [{ source: "Hello", target: "你好" }] })
      : JSON.stringify({ translations: context.cues.map((cue) => ({ id: cue.id, text: `[模拟译] ${cue.text}` })) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(19009, "127.0.0.1", () => console.log("mock LLM on http://127.0.0.1:19009/v1"));
