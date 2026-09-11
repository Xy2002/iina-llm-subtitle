# Third-party notices

This plugin bundles and downloads third-party software. This file describes
what it uses, under which license, and where to get the corresponding source.

## FFmpeg (LGPL-2.1-or-later)

The plugin downloads a **minimal FFmpeg build** on first run (only when no
system-wide `ffmpeg` is found) to extract embedded text subtitles from video
containers.

- Upstream project: <https://ffmpeg.org>
- License: GNU Lesser General Public License v2.1 or later
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>)
- Source code: the exact version we build (FFmpeg 8.1.2) is available from
  <https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>. Our build scripts
  (`scripts/build-ffmpeg-minimal.sh`) contain the complete, unmodified
  `configure` invocation used to produce the binaries we distribute, so you
  can rebuild them from that source.

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

The build is statically linked against FFmpeg's LGPL libraries. In compliance
with LGPL §4 (combined works), we provide the FFmpeg source tarball above plus
our exact build script so you may relink a modified version. The FFmpeg
binaries are downloaded separately from the plugin package precisely so they
can be replaced independently of the plugin code.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Components NOT distributed to end users

The following are development-time only and are not part of the distributed
plugin package: esbuild (MIT, bundler), Node.js test runner, TypeScript
(Apache-2.0, checker), iina-plugin-definition (MIT, type definitions).

## This plugin

License: MIT (see the `LICENSE` file in the repository).
