# Third-party notices

This plugin downloads third-party software. This file describes
what it uses, under which license, and where to get the corresponding source.

## FFmpeg (LGPL-2.1-or-later)

The plugin downloads a **minimal FFmpeg build** on first run (only when no
system-wide `ffmpeg` is found) to extract embedded text subtitles from video
containers.

- Upstream project: <https://ffmpeg.org>
- License: GNU Lesser General Public License v2.1 or later
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>)
- Current local build: `scripts/build-ffmpeg-minimal.sh universal` generates
  a distribution set in `dist/ffmpeg-tools/release/`. It includes the binaries,
  the unmodified `ffmpeg-<version>.tar.xz` archive used to compile both slices,
  `COPYING.FFmpeg.LGPLv2.1`, `build-ffmpeg-minimal.sh`, `FFMPEG_BUILD.txt`, and
  `ffmpeg-config-arm64.log` / `ffmpeg-config-x86_64.log`.
  `FFMPEG_BUILD.txt` identifies the exact FFmpeg version; the current default
  is 8.1.2, obtained from
  <https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>.
- Publication status: these updated distribution materials have been built
  and checked locally. They have not been published by this change. The
  release workflow will upload the generated set when a release tag is next
  published. For an existing
  [GitHub Release](https://github.com/Xy2002/iina-llm-subtitle/releases),
  check its actual attachment list; older releases may not contain this set.
- The generated build script and configure logs record the complete build
  settings. The script extracts both architecture builds from the same
  source archive without applying patches. Put that archive in
  `dist/ffmpeg-build/` in a checkout of the corresponding plugin release tag
  and run the command in `FFMPEG_BUILD.txt` to rebuild without downloading it.
- The generated `SHA256SUMS` covers the FFmpeg binaries and accompanying
  materials. Run `shasum -a 256 -c SHA256SUMS` in that output directory, or in
  a directory containing the complete set after it has been published.

Configuration of our build (LGPL, no GPL components enabled):
`--disable-everything --disable-autodetect --disable-network --disable-gpl
--disable-nonfree --disable-version3 --disable-doc --disable-debug
--disable-avdevice --disable-swresample --disable-swscale --disable-devices
--disable-bsfs --disable-hwaccels --disable-parsers --disable-indevs
--disable-outdevs --disable-x86asm --enable-small --enable-pic --enable-static
--disable-shared --enable-zlib --enable-iconv --extra-ldflags=-liconv
--enable-protocol=file,pipe --enable-demuxer=matroska,mov,srt,ass,webvtt
--enable-decoder=subrip,ass,ssa,movtext,webvtt --enable-encoder=subrip,ass,webvtt
--enable-muxer=srt,ass,webvtt`

Both builds also set `--enable-cross-compile --target-os=darwin` and an
explicit architecture. The arm64 slice targets macOS 11.0; the x86_64 slice
targets macOS 10.15 and additionally disables inline assembly. The full
compiler/linker arguments are in the generated recipe and configure logs.

This software uses code of FFmpeg licensed under the LGPLv2.1 or later.
The standalone FFmpeg programs statically link FFmpeg's own LGPL libraries;
the plugin calls those programs as subprocesses. The current build prepares
the matching source archive, license text, and recipe alongside the binaries
for distribution, so recipients can rebuild or modify them. Downloaded FFmpeg
programs can be replaced independently of the plugin.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Components NOT distributed to end users

The following are development-time only and are not part of the distributed
plugin package: esbuild (MIT, bundler), Node.js test runner, TypeScript
(Apache-2.0, checker), iina-plugin-definition (MIT, type definitions).

## This plugin

License: MIT (see the `LICENSE` file in the repository).
