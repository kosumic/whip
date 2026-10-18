#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
native_dir="$root_dir/node_modules/react-native-enriched-markdown/cpp"
build_dir="$root_dir/build/native-markdown-tests"
mkdir -p "$build_dir"

"${CC:-cc}" -std=c11 -DMD4C_USE_UTF8=1 \
  -c "$native_dir/md4c/md4c.c" -o "$build_dir/md4c.o"
"${CXX:-c++}" -std=c++17 -I "$native_dir/parser" \
  "$native_dir/parser/MD4CParser.cpp" \
  "$root_dir/__tests__/nativeMarkdownParser.cpp" "$build_dir/md4c.o" \
  -o "$build_dir/native-markdown-tests"
"$build_dir/native-markdown-tests"
