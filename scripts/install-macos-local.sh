#!/usr/bin/env bash
# Build the T3 Code desktop app for this Mac, sign it with a local certificate,
# and replace the copy in /Applications.
#
# The build itself is the repo's normal unsigned macOS artifact build
# (scripts/build-desktop-artifact.ts). Signing happens afterwards with a
# self-signed code-signing certificate that this script creates once in the
# login keychain, so rebuilt apps keep one stable signing identity and macOS
# keeps their keychain items.
#
# Usage: scripts/install-macos-local.sh [--arch arm64|x64|universal]
#                                       [--identity <keychain identity name>]
#                                       [--skip-build] [--force] [--verbose]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_IDENTITY_NAME="T3 Code Local Self-Signed"
APPLICATIONS_DIR="/Applications"
DESKTOP_BUNDLE_ID="com.t3tools.t3code"

arch=""
identity_name="${T3CODE_LOCAL_SIGN_IDENTITY:-$DEFAULT_IDENTITY_NAME}"
skip_build=0
force=0
verbose=0

log() { printf '[install-macos-local] %s\n' "$*"; }
fail() {
  printf '[install-macos-local] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      arch="${2:-}"
      [[ -n "$arch" ]] || fail "--arch needs a value"
      shift 2
      ;;
    --identity)
      identity_name="${2:-}"
      [[ -n "$identity_name" ]] || fail "--identity needs a value"
      shift 2
      ;;
    --skip-build) skip_build=1; shift ;;
    --force) force=1; shift ;;
    --verbose) verbose=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this script only runs on macOS"

if [[ -z "$arch" ]]; then
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) fail "unsupported host architecture: $(uname -m)" ;;
  esac
fi

cd "$REPO_ROOT"

# --- toolchain -------------------------------------------------------------

if [[ ! -d node_modules ]]; then
  log "Installing workspace dependencies (pnpm install)..."
  pnpm install
fi
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

# native/resource-monitor is a Rust crate the artifact build always compiles.
# Prefer a cargo already on PATH; otherwise borrow one from nix for this build
# only, so the script installs nothing permanently.
build_runner=()
if [[ $skip_build -eq 0 ]] && ! command -v cargo >/dev/null 2>&1; then
  if command -v nix >/dev/null 2>&1; then
    log "cargo not found; building inside 'nix shell nixpkgs#cargo nixpkgs#rustc'."
    build_runner=(nix shell nixpkgs#cargo nixpkgs#rustc --command)
  else
    fail "cargo is required to build native/resource-monitor. Install Rust (https://rustup.rs) or nix."
  fi
fi

# --- signing identity ------------------------------------------------------

login_keychain="$(security default-keychain -d user | tr -d ' "')"

identity_exists() {
  security find-identity -v -p codesigning "$login_keychain" | grep -qF "$identity_name"
}

create_self_signed_identity() {
  local workdir
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' RETURN

  cat >"$workdir/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = codesign_ext
prompt = no

[ dn ]
CN = $identity_name
O = T3 Code local builds

[ codesign_ext ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

  log "Creating self-signed code-signing certificate '$identity_name'."
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -config "$workdir/openssl.cnf" \
    -keyout "$workdir/key.pem" -out "$workdir/cert.pem" >/dev/null 2>&1

  openssl pkcs12 -export \
    -inkey "$workdir/key.pem" -in "$workdir/cert.pem" \
    -name "$identity_name" -out "$workdir/identity.p12" \
    -passout pass:t3code >/dev/null 2>&1

  security import "$workdir/identity.p12" -k "$login_keychain" -P t3code \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null

  log "macOS asks for your password to trust the new certificate for code signing."
  security add-trusted-cert -r trustRoot -p codeSign -k "$login_keychain" "$workdir/cert.pem"

  # Best effort: lets codesign use the key without a per-build GUI prompt. It
  # needs the login keychain password, so it usually fails here. The first
  # codesign run then shows one "Allow"/"Always Allow" dialog instead.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -D "$identity_name" -t private "$login_keychain" >/dev/null 2>&1 || true
}

if identity_exists; then
  log "Using existing signing identity '$identity_name'."
elif [[ "$identity_name" == "$DEFAULT_IDENTITY_NAME" ]]; then
  create_self_signed_identity
  identity_exists || fail "certificate '$identity_name' was created but is not valid for code signing"
else
  fail "signing identity '$identity_name' was not found in $login_keychain"
fi

# --- build -----------------------------------------------------------------

release_dir="$REPO_ROOT/release"
artifact_glob="$release_dir/T3-Code-"*"-$arch.zip"

if [[ $skip_build -eq 0 ]]; then
  log "Building the macOS artifact (arch=$arch). This takes several minutes."
  build_args=(node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$arch")
  [[ $verbose -eq 1 ]] && build_args+=(--verbose)
  "${build_runner[@]}" "${build_args[@]}"
fi

# shellcheck disable=SC2086 # deliberate glob expansion
newest_zip="$(ls -t $artifact_glob 2>/dev/null | head -1 || true)"
[[ -n "$newest_zip" ]] || fail "no artifact matching $artifact_glob. Run without --skip-build."
log "Using artifact $newest_zip"

# --- sign ------------------------------------------------------------------

stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT

ditto -x -k "$newest_zip" "$stage_dir"
app_path="$(find "$stage_dir" -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$app_path" ]] || fail "the artifact did not contain an .app bundle"
app_name="$(basename "$app_path")"

log "Signing $app_name with '$identity_name'."
# No hardened runtime: Electron needs JIT and unsigned executable memory, which
# hardened runtime only allows through entitlements the release build supplies.
codesign --force --deep --sign "$identity_name" "$app_path"
codesign --verify --deep --strict "$app_path"
# No early-exit filter here: closing the pipe would make codesign die of
# SIGPIPE, and pipefail would report that as a failure.
signature_authority="$(codesign -dvv "$app_path" 2>&1 | awk -F= '/^Authority=/ && !seen++ { print $2 }')"
log "Signature authority: ${signature_authority:-unknown}"

# --- install ---------------------------------------------------------------

destination="$APPLICATIONS_DIR/$app_name"

if /usr/bin/lsappinfo find "bundleID=$DESKTOP_BUNDLE_ID" 2>/dev/null | grep -q .; then
  if [[ $force -eq 0 ]]; then
    fail "$app_name is running. Quit it yourself and rerun, or pass --force to replace it while it runs."
  fi
  log "warning: $app_name is running; replacing it anyway (--force). Restart it to pick up this build."
fi

if [[ -e "$destination" ]]; then
  backup="$HOME/.Trash/${app_name%.app} backup $(date +%Y%m%d-%H%M%S).app"
  log "Moving the installed app to $backup"
  mv "$destination" "$backup"
fi

log "Installing to $destination"
ditto "$app_path" "$destination"
xattr -dr com.apple.quarantine "$destination" 2>/dev/null || true

installed_version="$(/usr/bin/defaults read "$destination/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)"
log "Installed $app_name $installed_version ($arch), signed by '$identity_name'."
