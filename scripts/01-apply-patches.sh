#!/usr/bin/env bash
# 01 — apply the patch series to the pruned Chromium source tree, in order:
#       1. ungoogled-chromium base            (de-Google)                     — both targets
#       2. ungoogled-chromium-windows overlay (Windows build patches)         — both targets
#       3. Clearcote patch set (this repo's patches/, listed in patches/series) — both targets
#
# Since Chromium 150 ONE patched tree builds both binaries: the released Windows and Linux builds
# come from the same source tree, so the overlay and the whole series apply for either TARGET.
# That is also a hard requirement: 905-rc-invoked-guard is written against the overlay's
# chrome_command_ids.h and rejects on a tree without it. 900-windows-build-fixes only touches
# Windows resource/toolchain files, so it changes nothing in a Linux build. Every patch is a
# plain unified diff (-p1) against the pinned revision in UPSTREAM_REVISION.
#
#   TARGET  windows | linux   (default: windows)
#   WORK    working dir (default: ~/clearcote-build)
#   REPO    path to this repository (default: parent of this script)
set -euo pipefail
TARGET="${TARGET:-windows}"
WORK="${WORK:-$HOME/clearcote-build}"
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$WORK/build/src"
UG="$WORK/ungoogled-chromium"
UGW="$WORK/ungoogled-chromium-windows"
PATCHES_PY="$UG/utils/patches.py"

[ -d "$SRC" ] || { echo "FATAL: source tree $SRC not found — run scripts/00-fetch-source.sh first"; exit 1; }
[ -f "$PATCHES_PY" ] || { echo "FATAL: $PATCHES_PY not found — run scripts/00-fetch-source.sh first"; exit 1; }

# 1. ungoogled base (both targets)
echo "  applying: ungoogled-chromium base (de-Google)"
python3 "$PATCHES_PY" apply "$SRC" "$UG/patches"

# 2. ungoogled-chromium-windows overlay (both targets — see the header)
echo "  applying: ungoogled-chromium-windows overlay"
python3 "$PATCHES_PY" apply "$SRC" "$UGW/patches"

# 3. Clearcote patch set, in patches/series order (-p1), both targets.
echo "  applying: Clearcote patch set (patches/series, target=$TARGET)"
while IFS= read -r line; do
  p="${line%%#*}"; p="$(printf '%s' "$p" | tr -d '[:space:]')"; [ -z "$p" ] && continue
  echo "    $p"
  patch -p1 -s -d "$SRC" < "$REPO/patches/$p"
done < "$REPO/patches/series"

# Patch-integrity gate (Layer 1). Every patch we just applied MUST now reverse-apply cleanly
# to the tree; if one silently rejected, fuzzed into the wrong place, or partially applied, this
# catches it HERE — before a single object file is built — instead of quietly shipping a
# de-stealthed binary. Same gate the release runbook re-runs against the packaged artifact.
# See docs/PATCH-INTEGRITY.md. Set CLEARCOTE_SKIP_PATCH_VERIFY=1 only for local debugging.
if [ "${CLEARCOTE_SKIP_PATCH_VERIFY:-0}" != "1" ]; then
  echo "  verifying: patch integrity (reverse-apply gate)"
  python3 "$REPO/scripts/verify_patches.py" --tree "$SRC" --target "$TARGET"
fi

echo "OK: patch series applied to $SRC (target=$TARGET)"
echo "next -> scripts/02-host-toolchain.sh"
