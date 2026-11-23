#!/bin/bash
# Put the certificate in CSC_LINK (a .p12, base64) and CSC_KEY_PASSWORD into a keychain of
# its own, and export what build/resign-mac.cjs reads: OPENSTEMS_SIGN_IDENTITY (the
# certificate's SHA-1) and OPENSTEMS_SIGN_KEYCHAIN. Meant to be sourced in a CI step:
#
#   source build/import-mac-cert.sh
#
# Prints nothing secret: the certificate's name and its SHA-1, which the signature shows
# to anyone anyway. The keychain lives in the runner's temp folder and goes with it.
set -euo pipefail

work="${RUNNER_TEMP:-$(mktemp -d)}/openstems-signing"
mkdir -p "$work"
OPENSTEMS_SIGN_KEYCHAIN="$work/signing.keychain-db"
keychain_password="$(uuidgen)"
printf '%s' "$CSC_LINK" | base64 --decode > "$work/cert.p12"
security create-keychain -p "$keychain_password" "$OPENSTEMS_SIGN_KEYCHAIN"
security set-keychain-settings -lut 3600 "$OPENSTEMS_SIGN_KEYCHAIN"
security unlock-keychain -p "$keychain_password" "$OPENSTEMS_SIGN_KEYCHAIN"
security import "$work/cert.p12" -k "$OPENSTEMS_SIGN_KEYCHAIN" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$work/cert.p12"
# Let codesign use the key with no prompt (there is nobody to answer one).
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$OPENSTEMS_SIGN_KEYCHAIN" >/dev/null
# codesign looks for the key in the search list.
security list-keychains -d user -s "$OPENSTEMS_SIGN_KEYCHAIN" $(security list-keychains -d user | tr -d '"')
# Without -v: a self-signed certificate is not trusted here, and -v would hide it.
OPENSTEMS_SIGN_IDENTITY="$(security find-identity -p codesigning "$OPENSTEMS_SIGN_KEYCHAIN" | grep -m1 -oE '[0-9A-F]{40}')"
if [ -z "$OPENSTEMS_SIGN_IDENTITY" ]; then
  echo "::error::The certificate in CSC_LINK holds no code-signing identity."
  exit 1
fi
echo "signing identity: $(security find-identity -p codesigning "$OPENSTEMS_SIGN_KEYCHAIN" | grep -m1 -oE '"[^"]+"') ($OPENSTEMS_SIGN_IDENTITY)"
export OPENSTEMS_SIGN_IDENTITY OPENSTEMS_SIGN_KEYCHAIN
set +euo pipefail
