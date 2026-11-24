#!/bin/bash
# Makes the certificate the Mac build is signed with when there is no Apple Developer ID:
# a self-signed code signing certificate and its key, as a .p12 file.
#
#   scripts/make-mac-cert.sh "OpenStems Self-Signed" <folder outside the repository> <password>
#
# Runs in Git Bash on Windows or in a terminal on a Mac; it needs only openssl. It prints
# what to store as the repository secrets CSC_LINK and CSC_KEY_PASSWORD.
#
# Make it once and keep the folder safe. Every release must be signed with this same
# certificate: an installed app accepts an update only from the certificate it was signed
# with, so if the key is lost, everyone installs the next version by hand once more. Anyone
# who has the key can sign an update the app will accept. Never commit any of these files.
# The certificate is valid for 20 years. docs/adr/0018-mac-self-signed.md.
set -euo pipefail

name="${1:?the name on the certificate, such as \"OpenStems Self-Signed\"}"
out="${2:?a folder to write into, outside the repository}"
password="${3:?a password for the .p12 file}"

mkdir -p "$out"
cat > "$out/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

# The name goes in through the file above, not -subj: Git Bash would rewrite "/CN=...".
openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$out/cert.cnf" \
  -keyout "$out/key.pem" -out "$out/cert.pem" 2>/dev/null

# macOS reads only the older .p12 encryption. OpenSSL 3 needs to be asked for it
# (-legacy); OpenSSL 1 and LibreSSL, which a Mac has, write it by default and do not know
# the flag.
export P12_PASSWORD="$password"
if ! openssl pkcs12 -export -legacy -inkey "$out/key.pem" -in "$out/cert.pem" -name "$name" \
  -out "$out/cert.p12" -passout env:P12_PASSWORD 2>/dev/null; then
  openssl pkcs12 -export -inkey "$out/key.pem" -in "$out/cert.pem" -name "$name" \
    -out "$out/cert.p12" -passout env:P12_PASSWORD
fi
openssl base64 -A -in "$out/cert.p12" -out "$out/cert.p12.base64"
rm -f "$out/cert.cnf"

echo "Wrote $out/cert.p12 (certificate and key), cert.pem, key.pem and cert.p12.base64."
echo "Repository secrets: CSC_LINK = the contents of cert.p12.base64, CSC_KEY_PASSWORD = the password."
