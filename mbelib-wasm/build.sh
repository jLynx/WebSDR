#!/bin/bash
# Build mbelib as WASM module for BrowSDR DSD decoder.
#
# Prerequisites: Emscripten SDK (emcc) must be in PATH.
#   Install: https://emscripten.org/docs/getting_started/downloads.html
#
# Usage: cd mbelib-wasm && bash build.sh
#
# Output: ../public/lib/mbelib/mbelib.js + mbelib.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../public/lib/mbelib"
MBELIB_DIR="$SCRIPT_DIR/mbelib"

# Clone mbelib if not present
if [ ! -d "$MBELIB_DIR" ]; then
    echo "Downloading mbelib source..."
    curl -sL "https://github.com/szechyjs/mbelib/archive/9a04ed5c78176a9965f3d43f7aa1b1f5330e771f.tar.gz" | tar xz -C "$SCRIPT_DIR"
    mv "$SCRIPT_DIR/mbelib-9a04ed5c78176a9965f3d43f7aa1b1f5330e771f" "$MBELIB_DIR"
    echo "mbelib source downloaded."
fi

mkdir -p "$OUT_DIR"

echo "Building mbelib WASM..."
emcc -O3 \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='MbelibModule' \
    -s EXPORTED_FUNCTIONS='["_mbelib_init","_mbelib_reset","_mbelib_decode_ambe","_mbelib_decode_imbe","_mbelib_get_err_str","_mbelib_get_errs","_mbelib_get_errs2","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","UTF8ToString","HEAPF32","HEAP8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=1048576 \
    -s ENVIRONMENT='web,worker' \
    -s FILESYSTEM=0 \
    -s ASSERTIONS=0 \
    -I"$MBELIB_DIR" \
    -o "$OUT_DIR/mbelib.js" \
    "$SCRIPT_DIR/wrapper.c" \
    "$MBELIB_DIR/ambe3600x2400.c" \
    "$MBELIB_DIR/ambe3600x2450.c" \
    "$MBELIB_DIR/ecc.c" \
    "$MBELIB_DIR/imbe7100x4400.c" \
    "$MBELIB_DIR/imbe7200x4400.c" \
    "$MBELIB_DIR/mbelib.c"

echo "Build complete: $OUT_DIR/mbelib.js + mbelib.wasm"
echo "File sizes:"
ls -lh "$OUT_DIR"/mbelib.*
