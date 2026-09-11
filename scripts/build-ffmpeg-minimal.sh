#!/bin/bash
# Build the minimal LGPL FFmpeg subset that the plugin downloads on first
# run (extraction of embedded text subtitles only). Recipe validated in
# docs/research/embedded-extraction.md; flags recorded in
# THIRD_PARTY_NOTICES.md satisfy the LGPL source offer.
#
# Usage: build-ffmpeg-minimal.sh <arch>            # arm64 | x86_64
#        build-ffmpeg-minimal.sh universal         # both + lipo
# Output: dist/ffmpeg-tools/<arch>/{ffmpeg,ffprobe}
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.2}"
FFMPEG_SOURCE="https://www.ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_BASE="$ROOT/dist/ffmpeg-tools"
WORK_BASE="$ROOT/dist/ffmpeg-build"

COMMON_FLAGS=(
  --disable-everything --disable-autodetect --disable-network
  --disable-gpl --disable-nonfree --disable-version3 --disable-doc
  --disable-debug --disable-avdevice --disable-swresample --disable-swscale
  --disable-devices --disable-bsfs --disable-hwaccels --disable-parsers
  --disable-indevs --disable-outdevs --disable-x86asm --enable-small
  --enable-pic --enable-static --disable-shared --enable-zlib --enable-iconv
  --extra-ldflags=-liconv
  --enable-protocol=file,pipe
  --enable-demuxer=matroska,mov,srt,ass,webvtt
  --enable-decoder=subrip,ass,ssa,movtext,webvtt
  --enable-encoder=subrip,ass,webvtt
  --enable-muxer=srt,ass,webvtt
)

build_for_arch() {
  local arch="$1" srcDir outDir
  srcDir="$WORK_BASE/ffmpeg-$FFMPEG_VERSION-$arch"
  outDir="$OUT_BASE/$arch"
  mkdir -p "$srcDir" "$outDir"

  if [ ! -f "$srcDir/configure" ]; then
    echo "Fetching FFmpeg $FFMPEG_VERSION source..."
    curl -fsSL "$FFMPEG_SOURCE" | tar xJ --strip-components=1 -C "$srcDir"
  fi

  local flags=("${COMMON_FLAGS[@]}")
  if [ "$arch" = "x86_64" ]; then
    # Cross-compiling the Intel slice on an arm64 host needs these three
    # extra switches (validated in docs/research/embedded-extraction.md).
    flags+=(--disable-inline-asm --enable-cross-compile --arch=x86_64
            --target-os=darwin
            --extra-cflags="-arch x86_64" --extra-ldflags="-arch x86_64 -liconv")
  fi

  (
    cd "$srcDir"
    ./configure --prefix="$outDir" "${flags[@]}"
    # --disable-avfilter must be avoided: without it the ffmpeg binary is
    # silently not built at all.
    make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
    cp ffmpeg ffprobe "$outDir/"
  )
  echo "built $outDir/{ffmpeg,ffprobe} ($arch)"
}

case "${1:-}" in
  arm64)   build_for_arch arm64 ;;
  x86_64)  build_for_arch x86_64 ;;
  universal)
    build_for_arch arm64
    build_for_arch x86_64
    mkdir -p "$OUT_BASE/universal"
    lipo -create -output "$OUT_BASE/universal/ffmpeg" \
      "$OUT_BASE/arm64/ffmpeg" "$OUT_BASE/x86_64/ffmpeg"
    lipo -create -output "$OUT_BASE/universal/ffprobe"       "$OUT_BASE/arm64/ffprobe" "$OUT_BASE/x86_64/ffprobe"
    echo "universal binaries in $OUT_BASE/universal/"
    ;;
  *) echo "usage: $0 arm64|x86_64|universal" >&2; exit 1 ;;
esac
