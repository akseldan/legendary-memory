#!/bin/sh
# Legendary Memory installer for macOS and Linux.
#
#   curl -fsSL https://akseldan.github.io/legendary-memory/install.sh | sh
#
# What it does, and nothing more:
#   1. Downloads a private copy of Node.js into ~/.legendary-memory/runtime and checks it
#      against a SHA-256 pinned below. Any Node.js you already have is left alone.
#   2. Downloads Legendary Memory from its GitHub release into ~/.legendary-memory/bin and
#      checks it against the release's SHA256SUMS file.
#   3. Adds ~/.legendary-memory/bin to your PATH (skip with --no-modify-path).
#   4. Opens the welcome page, where you choose which AI apps to connect. No app is
#      changed until you click Connect there.
#
# It never needs sudo and never touches your memory (~/.legendary-memory/memory.db).
# Running it again updates the program in place.
#
#   --dry-run          print what it would do, change nothing
#   --no-start         install without opening the welcome page
#   --no-modify-path   leave your shell startup files alone
#   --version vX.Y.Z   install that release instead of the latest
#   --uninstall        disconnect the apps and remove the program; your memory stays

set -eu

REPO_URL='https://github.com/akseldan/legendary-memory'
SITE_URL='https://akseldan.github.io/legendary-memory'
NODE_VERSION='24.22.3'

# From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt, whose signature was checked
# against the Node.js release keys (github.com/nodejs/release-keys) on 2026-11-17.
node_sha256() {
  case "$1" in
    darwin-arm64) printf '%s' 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd' ;;
    darwin-x64) printf '%s' '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7' ;;
    linux-arm64) printf '%s' '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8' ;;
    linux-x64) printf '%s' '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2' ;;
  esac
}

# Marks the lines this installer adds to a shell startup file, so they can be taken out again.
BLOCK_START='# >>> legendary-memory >>>'
BLOCK_END='# <<< legendary-memory <<<'

say() { printf '%s\n' "$*"; }
ok() { printf '  \342\234\223 %s\n' "$*"; }
die() {
  printf '\nLegendary Memory was not installed: %s\n' "$*" >&2
  exit 1
}

# Downloads $1 to $2. Only https, unless a test points the installer at a local mirror.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    progress='--silent'
    [ "${3-}" = big ] && [ -t 2 ] && progress='--progress-bar'
    curl --fail --location --show-error $progress --proto "$PROTO" --retry 2 --connect-timeout 20 -o "$2" "$1" ||
      die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "could not download $1"
  else
    die 'this needs curl or wget to download the program.'
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die 'this needs sha256sum or shasum to check the downloads.'
  fi
}

# Single-quotes a value for a shell script.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# The startup file a new terminal reads for this user's shell.
rc_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
    fish) printf '%s' "$HOME/.config/fish/conf.d/legendary-memory.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

detect_platform() {
  OS="${LM_TEST_OS:-$(uname -s)}"
  ARCH="${LM_TEST_ARCH:-$(uname -m)}"
  case "$OS" in
    Darwin | darwin) OS=darwin ;;
    Linux | linux) OS=linux ;;
    *) die "this installer is for macOS and Linux. On Windows, use the Claude Desktop extension or the steps in $REPO_URL#readme" ;;
  esac
  case "$ARCH" in
    x86_64 | amd64 | x64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) die "there is no Node.js build for this processor ($ARCH)." ;;
  esac
  if [ -z "${LM_TEST_ARCH-}" ]; then
    # A Terminal running under Rosetta reports an Intel Mac; install the native build anyway.
    if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
      ARCH=arm64
    fi
    if [ "$OS" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
      die "Node.js publishes no build for this Linux (musl, for example Alpine). Use the Docker image or install Node.js 22.20+ and follow $REPO_URL#readme"
    fi
  fi
  NODE_SHA256="$(node_sha256 "$OS-$ARCH")"
}

install_runtime() {
  if [ -x "$LM_HOME/runtime/bin/node" ] && [ "$(cat "$LM_HOME/runtime/VERSION" 2>/dev/null)" = "$NODE_VERSION" ] &&
    "$LM_HOME/runtime/bin/node" --version >/dev/null 2>&1; then
    ok "Node.js $NODE_VERSION, private copy (already there)"
    return
  fi
  name="node-v$NODE_VERSION-$OS-$ARCH"
  say "  Downloading Node.js $NODE_VERSION (about 50 MB)..."
  fetch "$NODE_MIRROR/v$NODE_VERSION/$name.tar.gz" "$TMP/node.tar.gz" big
  expected="${LM_TEST_NODE_SHA256:-$NODE_SHA256}"
  [ "$(sha256_of "$TMP/node.tar.gz")" = "$expected" ] || die 'the Node.js download does not match its published checksum, so it was not used.'
  mkdir "$TMP/unpacked" "$TMP/runtime" "$TMP/runtime/bin"
  tar -xzf "$TMP/node.tar.gz" -C "$TMP/unpacked" || die 'could not unpack Node.js.'
  # Only the program itself is needed; npm and the headers are left out.
  cp "$TMP/unpacked/$name/bin/node" "$TMP/runtime/bin/node"
  cp "$TMP/unpacked/$name/LICENSE" "$TMP/runtime/LICENSE" 2>/dev/null || true
  chmod 755 "$TMP/runtime/bin/node"
  printf '%s\n' "$NODE_VERSION" >"$TMP/runtime/VERSION"
  "$TMP/runtime/bin/node" --version >/dev/null 2>&1 || die 'the downloaded Node.js does not run on this computer.'
  # Swap it in whole. Apps already running keep the old copy until they restart.
  rm -rf "$LM_HOME/runtime.old"
  [ -d "$LM_HOME/runtime" ] && mv "$LM_HOME/runtime" "$LM_HOME/runtime.old"
  mv "$TMP/runtime" "$LM_HOME/runtime"
  rm -rf "$LM_HOME/runtime.old"
  ok "Node.js $NODE_VERSION, private copy (does not change any Node.js you have)"
}

install_app() {
  fetch "$RELEASE_URL/SHA256SUMS" "$TMP/SHA256SUMS"
  expected="$(awk '$2 == "legendary-memory.mjs" || $2 == "*legendary-memory.mjs" { print $1 }' "$TMP/SHA256SUMS")"
  [ -n "$expected" ] || die 'the release has no checksum for legendary-memory.mjs.'
  target="$LM_HOME/bin/legendary-memory.mjs"
  if [ -f "$target" ] && [ "$(sha256_of "$target")" = "$expected" ]; then
    APP_VERSION="$("$LM_HOME/runtime/bin/node" "$target" version 2>/dev/null || true)"
    ok "Legendary Memory $APP_VERSION (already up to date)"
    return
  fi
  fetch "$RELEASE_URL/legendary-memory.mjs" "$TMP/legendary-memory.mjs"
  [ "$(sha256_of "$TMP/legendary-memory.mjs")" = "$expected" ] || die 'the Legendary Memory download does not match its checksum, so it was not used.'
  APP_VERSION="$("$LM_HOME/runtime/bin/node" "$TMP/legendary-memory.mjs" version 2>/dev/null)" ||
    die 'the downloaded program did not start.'
  chmod 755 "$TMP/legendary-memory.mjs"
  mv "$TMP/legendary-memory.mjs" "$target"
  ok "Legendary Memory $APP_VERSION"
}

write_launcher() {
  launcher="$LM_HOME/bin/legendary-memory"
  {
    say '#!/bin/sh'
    say '# The legendary-memory command, written by the Legendary Memory installer.'
    say "LM_HOME=$(quote "$LM_HOME")"
    say "SITE_URL=$(quote "$SITE_URL")"
    cat <<'LAUNCHER'
set -eu
case "${1-}" in
  update)
    shift
    curl -fsSL "$SITE_URL/install.sh" | sh -s -- --no-start "$@"
    exit
    ;;
  uninstall)
    say() { printf '%s\n' "$*"; }
    say 'Disconnecting your AI apps...'
    "$LM_HOME/runtime/bin/node" "$LM_HOME/bin/legendary-memory.mjs" setup --undo ||
      say '(Some apps could not be disconnected; the list above says which.)'
    for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
      if [ -f "$rc" ] && grep -q '^# >>> legendary-memory >>>$' "$rc"; then
        # Drops the block and the one blank line the installer put before it.
        awk '
          skip { if ($0 == "# <<< legendary-memory <<<") skip = 0; next }
          $0 == "# >>> legendary-memory >>>" { if (blank > 0) blank--; skip = 1; next }
          $0 == "" { blank++; next }
          { while (blank > 0) { print ""; blank-- } print }
          END { while (blank > 0) { print ""; blank-- } }' "$rc" >"$rc.lm-tmp"
        cat "$rc.lm-tmp" >"$rc" # writes through a symlinked dotfile instead of replacing it
        rm -f "$rc.lm-tmp"
        say "Removed the PATH line from $rc"
      fi
    done
    rm -f "$HOME/.config/fish/conf.d/legendary-memory.fish"
    rm -rf "$LM_HOME/runtime" "$LM_HOME/runtime.old"
    rm -f "$LM_HOME/bin/legendary-memory.mjs" "$LM_HOME/bin/legendary-memory"
    rmdir "$LM_HOME/bin" 2>/dev/null || true
    say ''
    say 'Legendary Memory is uninstalled.'
    say "Your memory is still in $LM_HOME. Delete that folder to remove it too."
    exit 0
    ;;
esac
exec "$LM_HOME/runtime/bin/node" "$LM_HOME/bin/legendary-memory.mjs" "$@"
LAUNCHER
  } >"$TMP/launcher"
  chmod 755 "$TMP/launcher"
  mv "$TMP/launcher" "$launcher"
}

add_to_path() {
  case ":${PATH:-}:" in
    *":$LM_HOME/bin:"*) return ;; # already on PATH
  esac
  rc="$(rc_file)"
  if [ -f "$rc" ] && grep -q "^$BLOCK_START\$" "$rc"; then return; fi
  mkdir -p "$(dirname "$rc")"
  # The line keeps $HOME and $PATH as written, so the shell expands them when it starts.
  # shellcheck disable=SC2016
  if [ "$(basename "${SHELL:-sh}")" = fish ]; then
    line='set -gx PATH $HOME/.legendary-memory/bin $PATH'
  else
    line='export PATH="$HOME/.legendary-memory/bin:$PATH"'
  fi
  printf '\n%s\n%s\n%s\n' "$BLOCK_START" "$line" "$BLOCK_END" >>"$rc"
  PATH_CHANGED="$rc"
  ok "Added legendary-memory to your PATH in $rc"
}

main() {
  DRY_RUN=0 START=auto MODIFY_PATH=1 TAG='' UNINSTALL=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --no-start) START=0 ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --version)
        [ $# -ge 2 ] || die '--version needs a release, for example --version v1.1.0'
        TAG="$2"
        shift
        ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help)
        say 'Usage: install.sh [--dry-run] [--no-start] [--no-modify-path] [--version vX.Y.Z] [--uninstall]'
        say "Details: $REPO_URL#readme"
        exit 0
        ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done

  [ -n "${HOME-}" ] || die 'HOME is not set.'
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER-}" ]; then
    die 'run it without sudo. It installs into your own home folder and never needs administrator rights.'
  fi
  LM_HOME="$HOME/.legendary-memory"

  if [ "$UNINSTALL" = 1 ]; then
    [ -x "$LM_HOME/bin/legendary-memory" ] || die "there is no installed copy in $LM_HOME/bin."
    exec "$LM_HOME/bin/legendary-memory" uninstall
  fi

  detect_platform
  NODE_MIRROR="${LM_INSTALL_NODE_MIRROR:-https://nodejs.org/dist}"
  if [ -n "${LM_INSTALL_RELEASE_URL-}" ]; then
    RELEASE_URL="$LM_INSTALL_RELEASE_URL"
  elif [ -n "$TAG" ]; then
    RELEASE_URL="$REPO_URL/releases/download/$TAG"
  else
    RELEASE_URL="$REPO_URL/releases/latest/download"
  fi
  PROTO='=https'
  [ -n "${LM_INSTALL_NODE_MIRROR-}${LM_INSTALL_RELEASE_URL-}" ] && PROTO='=http,https'

  if [ "$DRY_RUN" = 1 ]; then
    say "Legendary Memory installer (dry run: nothing is changed)"
    say "  Platform    $OS-$ARCH"
    say "  Node.js     $NODE_MIRROR/v$NODE_VERSION/node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
    say "              sha256 $NODE_SHA256"
    say "  Program     $RELEASE_URL/legendary-memory.mjs (checked against SHA256SUMS)"
    say "  Installs to $LM_HOME/runtime and $LM_HOME/bin"
    if [ "$MODIFY_PATH" = 1 ]; then say "  PATH line   $(rc_file)"; else say '  PATH line   (left alone)'; fi
    say "  Leaves alone $LM_HOME/memory.db and every app's settings"
    exit 0
  fi

  say 'Installing Legendary Memory'
  mkdir -p "$LM_HOME"
  chmod 700 "$LM_HOME"
  mkdir -p "$LM_HOME/bin"
  TMP="$(mktemp -d "$LM_HOME/.install.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT TERM

  PATH_CHANGED=''
  install_runtime
  install_app
  write_launcher
  [ "$MODIFY_PATH" = 1 ] && add_to_path
  rm -rf "$TMP"
  trap - EXIT

  # This terminal only knows the short name if the folder was already on its PATH.
  command_name="$LM_HOME/bin/legendary-memory"
  case ":${PATH:-}:" in *":$LM_HOME/bin:"*) command_name='legendary-memory' ;; esac
  if [ "$START" = auto ]; then
    # Open the page when someone is watching; stay quiet in scripts and CI.
    if [ -t 1 ]; then START=1; else START=0; fi
  fi
  if [ "$START" = 1 ]; then
    say ''
    say 'Opening the welcome page, where you pick the AI apps to connect...'
    exec "$LM_HOME/bin/legendary-memory" start
  fi
  say ''
  say 'Done. To connect your AI apps, run:'
  say "  $command_name start"
  [ -n "$PATH_CHANGED" ] && say '(New terminal windows also know the short form: legendary-memory start)'
  say "To remove it later: $command_name uninstall"
}

main "$@"
