#!/bin/bash
# The self-signed update, end to end, on a Mac CI runner. Not for a Mac of your own: it
# tells the system to trust a throwaway certificate (with sudo) and leaves it there.
#
# It makes a certificate, builds the app twice with it (an older and a newer version, the
# way release-mac.yml builds a self-signed release), checks both signatures, serves the
# newer one from this machine and lets the older one update itself to it
# (e2e/mac-update.spec.ts). Run from app/, after "pnpm build" and "pnpm package:prepare":
#
#   bash scripts/mac-update-test.sh <path to an installed engine's openstems command>
set -euo pipefail

engine="${1:?the path to an installed engine command, such as ../engine/.venv/bin/openstems}"
work="${RUNNER_TEMP:?run on a CI runner}/self-signed-update"
name="OpenStems CI Self-Signed"
port=8765
rm -rf "$work"
mkdir -p "$work"

# A password made here and gone with the runner: the certificate signs nothing that ships.
CSC_KEY_PASSWORD="$(openssl rand -hex 16)"
bash ../scripts/make-mac-cert.sh "$name" "$work/cert" "$CSC_KEY_PASSWORD"
# electron-builder lists only certificates the system trusts for code signing.
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$work/cert/cert.pem"

CSC_LINK="$(cat "$work/cert/cert.p12.base64")"
export CSC_LINK CSC_KEY_PASSWORD OPENSTEMS_SELF_SIGNED=1 CSC_FOR_PULL_REQUEST=true
unset CSC_IDENTITY_AUTO_DISCOVERY
export UPDATE_FEED="http://127.0.0.1:$port"

build_version() { # version, folder
  UPDATE_VERSION="$1" UPDATE_OUT="$2" pnpm exec electron-builder --mac zip --config e2e/mac-update-build.cjs --publish never
}
build_version 0.0.1 "$work/old"
build_version 9.9.9 "$work/new"

for which in old new; do
  app="$work/$which/mac-arm64/OpenStems.app"
  echo "== $which"
  codesign --display --verbose=2 "$app" 2>&1 | grep -E "^(Authority|TeamIdentifier|Signature)=" || true
  codesign --display --verbose=2 "$app" 2>&1 | grep -qx "Authority=$name"
  codesign --verify --deep --strict "$app"
  codesign --display -r- "$app" 2>/dev/null | sed -n "s/^designated => //p" | tee "$work/$which.requirement"
done
# The same signer in both: this is what lets one replace the other.
cmp "$work/old.requirement" "$work/new.requirement"
grep -q "certificate leaf" "$work/old.requirement"
ls -l "$work/new"
test -f "$work/new/latest-mac.yml"

mkdir "$work/installed"
ditto "$work/old/mac-arm64/OpenStems.app" "$work/installed/OpenStems.app"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/new" > "$work/server.log" 2>&1 &
server=$!
finish() {
  kill "$server" 2>/dev/null || true
  # The updated app starts itself once it is in place.
  pkill -f "$work/installed/OpenStems.app" 2>/dev/null || true
  echo "== requests for the update"
  cat "$work/server.log" || true
  echo "== the log of the installer"
  tail -n 40 "$HOME/Library/Caches/ing.lewisgo.openstems.ShipIt/ShipIt_stderr.log" 2>/dev/null || true
}
trap finish EXIT

MAC_UPDATE_APP="$work/installed/OpenStems.app" MAC_UPDATE_ENGINE="$engine" pnpm e2e -g "mac update"
