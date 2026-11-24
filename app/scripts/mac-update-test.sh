#!/bin/bash
# The self-signed update, end to end, on a Mac CI runner. Not for a Mac of your own: it
# tells the system to trust the certificate (with sudo) and leaves it there.
#
# It builds the app twice, an older and a newer version, the way release-mac.yml builds a
# release: the same configuration and signing step, so with the project's certificate when
# CSC_LINK and CSC_KEY_PASSWORD are set (the repository secrets; a pull request from a fork
# has none), else with a throwaway one made here. It checks both signatures and that the
# newer build satisfies the older one's designated requirement (what the installer asks),
# serves the newer one from this machine and lets the older one update itself to it through
# the real updater (e2e/mac-update.spec.ts). Run from app/, after "pnpm build" and
# "pnpm package:prepare":
#
#   bash scripts/mac-update-test.sh <path to an installed engine's openstems command>
set -euo pipefail

engine="${1:?the path to an installed engine command, such as ../engine/.venv/bin/openstems}"
work="${RUNNER_TEMP:?run on a CI runner}/self-signed-update"
port=8765
rm -rf "$work"
mkdir -p "$work"

if [ -n "${CSC_LINK:-}" ] && [ -n "${CSC_KEY_PASSWORD:-}" ]; then
  echo "certificate: the project's own (repository secrets)"
else
  # A password made here and gone with the runner: the certificate signs nothing that ships.
  CSC_KEY_PASSWORD="$(openssl rand -hex 16)"
  bash ../scripts/make-mac-cert.sh "OpenStems CI Self-Signed" "$work/cert" "$CSC_KEY_PASSWORD" >/dev/null
  CSC_LINK="$(cat "$work/cert/cert.p12.base64")"
  echo "certificate: a throwaway one made here (no repository secrets)"
fi
export CSC_LINK CSC_KEY_PASSWORD

# The release workflow's own check, on this runner's openssl: it must call the certificate
# self-signed, and hand back the certificate the system is told to trust.
kind=$(bash ../scripts/mac-cert-kind.sh "$work/signing.pem")
echo "kind: $kind ($(openssl version))"
test "$kind" = self-signed
name=$(openssl x509 -in "$work/signing.pem" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= *//p')
echo "name: $name"
# electron-builder lists only certificates the system trusts for code signing.
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$work/signing.pem"

export OPENSTEMS_SELF_SIGNED=1 CSC_FOR_PULL_REQUEST=true
unset CSC_IDENTITY_AUTO_DISCOVERY

build_version() { # version, folder
  UPDATE_VERSION="$1" UPDATE_OUT="$2" pnpm exec electron-builder --mac zip --config e2e/mac-update-build.cjs --publish never
}
build_version 0.0.1 "$work/old"
build_version 9.9.9 "$work/new"
# The key is not needed from here on.
unset CSC_LINK CSC_KEY_PASSWORD

old="$work/old/mac-arm64/OpenStems.app"
new="$work/new/mac-arm64/OpenStems.app"
for app in "$old" "$new"; do
  echo "== $app"
  codesign --display --verbose=2 "$app" 2>&1 | grep -E "^(Authority|TeamIdentifier|Signature)=" || true
  codesign --display --verbose=2 "$app" 2>&1 | grep -qx "Authority=$name"
  codesign --verify --deep --strict "$app"
done
# What the installer asks before it puts an update in place: does the new app satisfy the
# running one's designated requirement? It must pin the certificate, and an app signed ad
# hoc must not pass it.
requirement=$(codesign --display -r- "$old" 2>&1 | sed -n 's/^designated => //p')
echo "requirement: $requirement"
case "$requirement" in *"certificate leaf"*) ;; *) echo "::error::the requirement pins no certificate"; exit 1 ;; esac
codesign --verify --deep --strict -R "=$requirement" "$new"
echo "the newer build satisfies the older one's requirement"
ditto "$new" "$work/adhoc.app"
codesign --force --deep --sign - "$work/adhoc.app" 2>/dev/null
if codesign --verify -R "=$requirement" "$work/adhoc.app" 2>/dev/null; then
  echo "::error::an app signed ad hoc satisfies the requirement"
  exit 1
fi
echo "an app signed ad hoc does not"
ls -l "$work/new"
test -f "$work/new/latest-mac.yml"

mkdir "$work/installed"
ditto "$old" "$work/installed/OpenStems.app"

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

MAC_UPDATE_APP="$work/installed/OpenStems.app" MAC_UPDATE_ENGINE="$engine" \
  MAC_UPDATE_FEED="http://127.0.0.1:$port" pnpm e2e -g "mac update"
