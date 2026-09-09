#!/usr/bin/env bash
# DevScope installer / updater for macOS.
#
#   Private repo (needs the GitHub CLI logged in):
#     gh api repos/martinPino/devscope/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#   Public repo:
#     curl -fsSL https://raw.githubusercontent.com/martinPino/devscope/main/install.sh | bash
#   From a checkout:
#     ./install.sh            (or: npm run install:app)
#
# Clones/updates the source into ~/.devscope/src (unless run from a checkout), builds the
# Electron app for this Mac, ad-hoc signs it, installs it into /Applications and opens it.
# Run it again to update. Env: DEVSCOPE_SRC, DEVSCOPE_DEST, DEVSCOPE_REF, DEVSCOPE_NO_OPEN=1.
set -euo pipefail

REPO="martinPino/devscope"
REF="${DEVSCOPE_REF:-main}"
DEST="${DEVSCOPE_DEST:-/Applications}"

bold=$'\033[1m'; yellow=$'\033[1;33m'; red=$'\033[1;31m'; dim=$'\033[2m'; reset=$'\033[0m'
log() { printf '%s▸%s %s\n' "$yellow" "$reset" "$*"; }
die() { printf '%s✗%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "This installer builds the macOS app. On other systems clone the repo and run 'npm run desktop'."
command -v git >/dev/null 2>&1 || die "git is required (run: xcode-select --install)."
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required (brew install node)."
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 18 )) || die "Node.js 18+ is required, found $(node -v)."

# Running from a checkout? Then build that checkout instead of cloning.
SRC="${DEVSCOPE_SRC:-}"
if [[ -z "$SRC" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)"
  if [[ -n "$script_dir" && -f "$script_dir/package.json" ]] && grep -q '"name": "devscope"' "$script_dir/package.json" 2>/dev/null; then
    SRC="$script_dir"
  else
    SRC="$HOME/.devscope/src"
  fi
fi

if [[ -d "$SRC/.git" && -f "$SRC/package.json" ]]; then
  if [[ -f "$SRC/.devscope-managed" ]]; then
    # A clone this installer made: fast-forward it to the latest $REF.
    log "Updating source in $SRC ${dim}($REF)${reset}"
    git -C "$SRC" fetch -q --depth 1 origin "$REF"
    git -C "$SRC" checkout -q -B "$REF" FETCH_HEAD
  else
    # Somebody's own checkout: build it as it is, never reset it.
    log "Building from checkout $SRC"
  fi
else
  log "Cloning $REPO into $SRC"
  mkdir -p "$(dirname "$SRC")"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$REPO" "$SRC" -- --depth 1 --branch "$REF" -q
  else
    git clone -q --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$SRC" 2>/dev/null \
      || git clone -q --depth 1 --branch "$REF" "git@github.com:$REPO.git" "$SRC" \
      || die "Could not clone $REPO. For a private repo, log in with 'gh auth login' first."
  fi
  touch "$SRC/.devscope-managed"
fi

cd "$SRC"
build_log="$(mktemp -t devscope-build)"
log "Installing dependencies ${dim}(first run downloads Electron, ~120 MB)${reset}"
NODE_ENV= npm ci --no-audit --no-fund --loglevel=error >"$build_log" 2>&1 || { cat "$build_log"; die "npm ci failed"; }
log "Building DevScope.app for this Mac"
npx electron-builder --mac dir >>"$build_log" 2>&1 || { tail -40 "$build_log"; die "electron-builder failed (full log: $build_log)"; }
app="$(ls -d dist/mac*/DevScope.app 2>/dev/null | head -1)"
[[ -d "$app" ]] || die "Build produced no app bundle (log: $build_log)"
codesign --force --deep --sign - "$app" >/dev/null 2>&1 || die "codesign failed"

# Install: replace the previous copy, closing it first if it is the one running.
if [[ ! -w "$DEST" ]]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
target="$DEST/DevScope.app"
if pgrep -f "$target/Contents/MacOS/DevScope" >/dev/null 2>&1; then
  log "Closing the running DevScope"
  osascript -e 'tell application "DevScope" to quit' >/dev/null 2>&1 || true
  sleep 2
  pkill -f "$target/Contents/MacOS/DevScope" >/dev/null 2>&1 || true
fi
rm -rf "$target"
ditto "$app" "$target"
rm -rf "$(dirname "$app")"
version="$(node -p 'require("./package.json").version')"
if [[ "$DEST" == "/Applications" || "$DEST" == "$HOME/Applications" ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" >/dev/null 2>&1 || true
fi
printf '%s✓%s DevScope %s installed at %s%s%s\n' "$yellow" "$reset" "$version" "$bold" "$target" "$reset"
printf '  Launch it from Spotlight or Launchpad. Run this command again to update.\n'
[[ -n "${DEVSCOPE_NO_OPEN:-}" ]] || open "$target"
