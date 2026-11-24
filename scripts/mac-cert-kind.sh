#!/bin/bash
# What kind of signing certificate CSC_LINK (a .p12 as base64) holds, for the Mac release
# (release-mac.yml) and its CI test (app/scripts/mac-update-test.sh):
#
#   bash scripts/mac-cert-kind.sh OUT.pem
#
# Prints "self-signed" (one the project made, scripts/make-mac-cert.sh: its own issuer) or
# "issued" (by someone else, such as Apple's Developer ID), and writes the certificate,
# without its key, to OUT.pem. Exits non-zero, printing nothing, when the .p12 cannot be
# read with CSC_KEY_PASSWORD: a broken secret must stop the release, not change its kind.
set -euo pipefail

out="${1:?where to write the certificate}"
: "${CSC_LINK:?CSC_LINK is not set}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is not set}"

p12="$(mktemp)"
trap 'rm -f "$p12"' EXIT
printf '%s' "$CSC_LINK" | openssl base64 -d -A > "$p12"

# The certificate in the .p12 is stored with an old cipher. OpenSSL 3 reads it only with
# -legacy; OpenSSL 1.1 and LibreSSL read it as it is and do not know the flag.
read_cert() {
  openssl pkcs12 -in "$p12" -passin env:CSC_KEY_PASSWORD -nokeys -clcerts "$@" 2>/dev/null \
    | openssl x509 -out "$out" 2>/dev/null
}
read_cert -legacy || read_cert || {
  echo "::error::the certificate in CSC_LINK cannot be read with CSC_KEY_PASSWORD" >&2
  exit 1
}

subject=$(openssl x509 -in "$out" -noout -subject_hash)
issuer=$(openssl x509 -in "$out" -noout -issuer_hash)
if [ -n "$subject" ] && [ "$subject" = "$issuer" ]; then
  echo self-signed
else
  echo issued
fi
