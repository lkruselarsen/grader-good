#!/usr/bin/env bash
# Vercel / Amazon Linux 2023 does not ship LibRaw-devel. lightdrift-libraw has no
# Linux prebuilds, so we compile the bundled LibRaw source before rebuilding the addon.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LIBRAW_HEADER="/usr/local/include/libraw/libraw.h"

ensure_autotools_compat() {
  # Bundled LibRaw was generated with automake 1.15; AL2023 ships 1.16.
  local aclocal_16 automake_16
  aclocal_16="$(command -v aclocal-1.16 2>/dev/null || true)"
  if [[ -n "$aclocal_16" ]] && ! command -v aclocal-1.15 >/dev/null 2>&1; then
    ln -sf "$aclocal_16" /usr/local/bin/aclocal-1.15
  fi
  automake_16="$(command -v automake-1.16 2>/dev/null || true)"
  if [[ -n "$automake_16" ]] && ! command -v automake-1.15 >/dev/null 2>&1; then
    ln -sf "$automake_16" /usr/local/bin/automake-1.15
  fi
}

ensure_build_tools() {
  if ! command -v dnf >/dev/null 2>&1; then
    return 0
  fi
  # LibRaw-devel is not in AL2023 repos; install compiler toolchain only.
  # coreutils provides cmp/diff used by LibRaw's configure script.
  dnf install -y gcc-c++ make autoconf automake libtool pkgconf-pkg-config coreutils || \
    dnf install -y gcc-c++ make
  ensure_autotools_compat
}

prepare_bundled_libraw_tree() {
  local libraw_src="$1"
  # npm pack does not preserve execute bits; configure.ac runs ./version.sh via m4.
  find "$libraw_src" -type f \( \
    -name '*.sh' -o -name 'configure' -o -name 'missing' \
    -o -name 'install-sh' -o -name 'compile' \
    -o -name 'config.guess' -o -name 'config.sub' -o -name 'ltmain.sh' \
  \) -exec chmod +x {} +
  # Release tarball ships generated autotools output; keep libtool from rebuilding it.
  if [[ -f "$libraw_src/aclocal.m4" ]]; then
    touch "$libraw_src/aclocal.m4"
    [[ -f "$libraw_src/Makefile.in" ]] && touch "$libraw_src/Makefile.in"
    [[ -f "$libraw_src/configure" ]] && touch "$libraw_src/configure"
  fi
}

find_bundled_libraw_src() {
  local base="$ROOT/node_modules/lightdrift-libraw/deps/LibRaw-Source"
  if [[ ! -d "$base" ]]; then
    return 1
  fi
  local dir
  # mindepth 1: "LibRaw-Source" itself also matches LibRaw-*
  dir="$(find "$base" -mindepth 1 -maxdepth 1 -type d -name 'LibRaw-*' | head -1)"
  [[ -n "$dir" && -f "$dir/configure" ]] || return 1
  printf '%s' "$dir"
}

build_bundled_libraw() {
  if [[ -f "$LIBRAW_HEADER" ]]; then
    echo "vercel-install: LibRaw already installed at $LIBRAW_HEADER"
    return 0
  fi

  local libraw_src
  libraw_src="$(find_bundled_libraw_src)" || {
    echo "vercel-install: bundled LibRaw source not found under lightdrift-libraw" >&2
    return 1
  }

  echo "vercel-install: building bundled LibRaw from $libraw_src"
  ensure_build_tools
  prepare_bundled_libraw_tree "$libraw_src"

  local jobs="${VERCEL_BUILD_CPUS:-2}"
  (
    cd "$libraw_src"
    bash configure --prefix=/usr/local
    [[ -f aclocal.m4 ]] && touch aclocal.m4
    make -j"$jobs" -o aclocal.m4
    make install -o aclocal.m4
  )
}

run_postinstall() {
  node scripts/patch-dcraw.js
  node scripts/copy-libraw-wasm.js
}

verify_lightdrift() {
  node -e "require('lightdrift-libraw')"
}

install_with_bundled_libraw() {
  echo "vercel-install: installing npm deps (skip native scripts)..."
  npm install --ignore-scripts
  build_bundled_libraw
  echo "vercel-install: rebuilding lightdrift-libraw..."
  npm rebuild lightdrift-libraw
  run_postinstall
  verify_lightdrift
  echo "vercel-install: lightdrift-libraw OK"
}

if [[ "${VERCEL:-}" == "1" ]]; then
  install_with_bundled_libraw
  exit 0
fi

# Local / CI with system libraw-dev: normal install.
if npm install && verify_lightdrift 2>/dev/null; then
  echo "vercel-install: standard npm install OK"
  exit 0
fi

echo "vercel-install: standard install failed; trying bundled LibRaw fallback..."
install_with_bundled_libraw
