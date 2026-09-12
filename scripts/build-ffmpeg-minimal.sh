#!/bin/bash
# Build the minimal LGPL FFmpeg subset that the plugin downloads on first
# run (extraction of embedded text subtitles only). Recipe validated in
# docs/research/embedded-extraction.md. THIRD_PARTY_NOTICES.md describes
# the source archive and license materials distributed with these binaries.
#
# Usage: build-ffmpeg-minimal.sh <arch>            # arm64 | x86_64
#        build-ffmpeg-minimal.sh universal         # both + lipo
# Output: dist/ffmpeg-tools/<arch>/{ffmpeg,ffprobe}
# Universal builds also produce release/ with binaries, matching source,
# license text, the build recipe, build metadata, and checksums.
set -euo pipefail

case "${1:-}" in
  arm64|x86_64|universal) ;;
  *) echo "usage: $0 arm64|x86_64|universal" >&2; exit 1 ;;
esac

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.2}"
if [[ ! "$FFMPEG_VERSION" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
  echo "FFMPEG_VERSION must be a numeric release version" >&2
  exit 1
fi
FFMPEG_SOURCE="https://www.ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_BASE="$ROOT/dist/ffmpeg-tools"
WORK_BASE="$ROOT/dist/ffmpeg-build"
SOURCE_ARCHIVE="$WORK_BASE/ffmpeg-$FFMPEG_VERSION.tar.xz"

mkdir -p "$WORK_BASE"
if [ ! -f "$SOURCE_ARCHIVE" ]; then
  echo "Fetching FFmpeg $FFMPEG_VERSION source..."
  curl -fsSL "$FFMPEG_SOURCE" -o "$SOURCE_ARCHIVE.tmp"
  mv "$SOURCE_ARCHIVE.tmp" "$SOURCE_ARCHIVE"
fi

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
  local arch="$1" srcDir outDir minimum
  srcDir="$WORK_BASE/ffmpeg-$FFMPEG_VERSION-$arch"
  outDir="$OUT_BASE/$arch"
  # Always compile pristine contents of the exact archive shipped to users.
  # Reusing an edited source tree would break that correspondence.
  rm -rf "$srcDir"
  mkdir -p "$srcDir" "$outDir"
  tar xJf "$SOURCE_ARCHIVE" --strip-components=1 -C "$srcDir"

  local flags=("${COMMON_FLAGS[@]}")
  minimum=11.0
  if [ "$arch" = "x86_64" ]; then
    # Cross-compiling the Intel slice also requires disabling inline assembly
    # (validated in docs/research/embedded-extraction.md).
    flags+=(--disable-inline-asm)
    minimum=10.15
  fi
  flags+=(--enable-cross-compile --arch="$arch" --target-os=darwin
          --extra-cflags="-arch $arch -mmacosx-version-min=$minimum"
          --extra-ldflags="-arch $arch -mmacosx-version-min=$minimum -liconv")

  (
    cd "$srcDir"
    ./configure --prefix="$outDir" "${flags[@]}"
    # --disable-avfilter must be avoided: without it the ffmpeg binary is
    # silently not built at all.
    make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
    cp ffmpeg ffprobe "$outDir/"
    cp ffbuild/config.log "$outDir/config.log"
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
    lipo -create -output "$OUT_BASE/universal/ffprobe" \
      "$OUT_BASE/arm64/ffprobe" "$OUT_BASE/x86_64/ffprobe"
    lipo "$OUT_BASE/universal/ffmpeg" -verify_arch arm64 x86_64
    lipo "$OUT_BASE/universal/ffprobe" -verify_arch arm64 x86_64
    releaseDir="$OUT_BASE/release"
    rm -rf "$releaseDir"
    mkdir -p "$releaseDir"
    cp "$OUT_BASE/universal/ffmpeg" "$OUT_BASE/universal/ffprobe" "$releaseDir/"
    cp "$SOURCE_ARCHIVE" "$releaseDir/"
    tar xJOf "$SOURCE_ARCHIVE" "ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" > "$releaseDir/COPYING.FFmpeg.LGPLv2.1"
    cp "$ROOT/scripts/build-ffmpeg-minimal.sh" "$ROOT/THIRD_PARTY_NOTICES.md" "$releaseDir/"
    cp "$OUT_BASE/arm64/config.log" "$releaseDir/ffmpeg-config-arm64.log"
    cp "$OUT_BASE/x86_64/config.log" "$releaseDir/ffmpeg-config-x86_64.log"
    cat > "$releaseDir/FFMPEG_BUILD.txt" <<EOF
FFmpeg version: $FFMPEG_VERSION
Source URL: $FFMPEG_SOURCE
Source archive: ffmpeg-$FFMPEG_VERSION.tar.xz (unmodified upstream archive)
Source patches: none
Architectures: arm64 (macOS 11.0+), x86_64 (macOS 10.15+)
Build recipe: scripts/build-ffmpeg-minimal.sh in the plugin repository;
the same script is attached to this release as build-ffmpeg-minimal.sh.
Rebuild from a checkout of this release's plugin tag:
  FFMPEG_VERSION=$FFMPEG_VERSION bash scripts/build-ffmpeg-minimal.sh universal
Place the supplied source archive in dist/ffmpeg-build/ to rebuild offline.
The ffmpeg-config-*.log files record the configure invocations and toolchain.
EOF
    (cd "$releaseDir" && shasum -a 256 ./* > SHA256SUMS)
    echo "universal binaries in $OUT_BASE/universal/"
    echo "release assets in $releaseDir/"
    ;;
  *) echo "usage: $0 arm64|x86_64|universal" >&2; exit 1 ;;
esac
