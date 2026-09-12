# iina-llm-subtitle

IINA 字幕翻译插件：调用 LLM 将视频的**内嵌 / 外挂字幕整轨翻译**为双语字幕（原文 + 译文两行，可切仅译文），结果本地缓存——同一部视频只翻译一次。

An IINA plugin that translates embedded / external subtitle tracks with an LLM and loads them back as bilingual subtitles, with local caching.

## 功能特性 / Features

- **整轨预翻译**：选中字幕轨一键翻译，质量优于逐句即时翻译；术语表预检保证人名/术语全片一致
- **双语 + 仅译文**：两种模式瞬时切换；译文颜色 / 字号比例 / 行序可调
- **本地缓存**：按「字幕内容哈希 + 模型 + 译入语言」缓存，二次观看零成本零等待；支持容量上限与一键清除
- **断点续翻**：中断后从缺失批次继续，不重复付费；严格 JSON 校验 + 自动重试 + 超时对半拆批
- **内嵌 + 外挂**：支持外挂 SRT / ASS 与容器内嵌文本轨（自动探测 ffmpeg 提取；位图轨如 PGS 需 OCR，暂不支持）
- **隐私设计**：API key 仅存本地 0600 凭据文件；所有外网请求经本地回环助手发出，插件自身只需回环域名权限
- **简中 / 英文**界面

## 安装 / Install

1. 到 [Releases](https://github.com/Xy2002/iina-llm-subtitle/releases) 下载最新的 `.iinaplgz`
2. IINA → 设置 → 插件 → 安装插件，选择该文件并启用
3. 在 IINA 设置 → 插件 → **LLM Subtitle Prototype** → Preferences 中配置：
   - **API 地址 / 模型**：填写 OpenAI 兼容服务的地址与模型名
   - 点击 **设置 API Key…**，在单独窗口中保存密钥；留空保存会移除密钥
   - 译入语言（默认简体中文）、显示模式、字幕样式、缓存管理等
4. 打开视频，选中一条文本字幕轨，菜单 **插件 → LLM Subtitle Prototype → 翻译字幕**

已有安装会通过 GitHub Release 自动收到更新提示。

密钥由本地助手写入权限为 `0600` 的凭据文件，不再保存在插件偏好中。升级时会迁移旧偏好中的密钥，写入成功后清除旧副本；原有凭据文件可以继续使用。插件菜单也提供 **设置 API Key…** 入口。

**FFmpeg 说明**：翻译内嵌字幕需要 ffmpeg/ffprobe。插件会依次使用：设置中指定的路径 → 系统 FFmpeg → 自动下载的最小 LGPL 构建（源码与构建脚本见 `THIRD_PARTY_NOTICES.md`）。翻译外挂字幕不需要 FFmpeg。

## 开发 / Development

需要 macOS、IINA 1.4.x、Node.js 22+、swiftc（helper 编译）、ffmpeg（仅 QA fixture）。

```sh
npm ci
npm run typecheck        # tsc 严格检查（JSDoc）
npm test                 # 引擎、IINA 接线、界面、打包与 helper 契约回归测试
npm run build:helper     # 编译 arm64 + x86_64 通用助手
npm run build            # 构建插件到 dist/（esbuild 单文件打包）
npm run dev:link         # 以开发模式链接进 IINA
npm run pack:plugin      # 编译助手、构建并生成 .iinaplgz
```

默认测试不等待真实的 65 秒慢请求；需要验证长请求时运行：

```sh
IINA_HELPER_SLOW_TEST=1 node --test --test-name-pattern="slow job" test/helper-contract.test.js
```

架构：`src/engine/`（纯 JS 核心：SRT/ASS 解析、批翻译循环、术语表预检、双变体装配、内容哈希缓存；零平台 API，端口注入，Node 与 JavaScriptCore 同码运行）+ `src/main.js`（播放器接线）+ `src/global.js`（共享助手与凭据窗口）+ `src/helper-client.js`（短请求提交与轮询）+ `helper/main.swift`（回环传输助手）+ `sidebar.html`（进度 UI）。上游长请求由助手执行，IINA 通过短请求读取状态。推送后 CI 跑 `typecheck + test`；`v*` 标签触发发布工作流。

发布构建要求助手包含 Apple Silicon 和 Intel 两个架构。FFmpeg 构建脚本同时生成二进制、对应源码包、许可文本、构建日志与校验和，发布流程上传整套文件。开发机上的构建与测试不等于已发布，也不替代 Intel Mac 的实机验证。

## 许可 / License

MIT（见 `LICENSE`）。FFmpeg 部分遵循 LGPL-2.1，源码要约与构建说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
