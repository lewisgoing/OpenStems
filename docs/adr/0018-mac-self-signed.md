# 0018: Mac self-update with a certificate of our own

Date: 2026-11-23. Status: accepted. Adds to ADR 0010 and ADR 0014.

## The problem

There is no Apple Developer ID for this project. The Mac build was therefore signed ad hoc,
and an installed Mac app could not update itself: it showed "Get 0.3.1" and opened the
release page (ADR 0010, "On a Mac"). The reason is in the installer inside Electron
(Squirrel): it puts a new version in place only if that version satisfies the running app's
*designated requirement*, which is what its signature says about who made it. An ad hoc
signature names nobody and its requirement is the hash of that one build, so no other build
can ever satisfy it.

## Decision

Sign the Mac build with a certificate the project makes itself. It costs nothing and asks
nothing of Apple.

- **What it changes.** With a self-signed certificate the designated requirement is "this
  bundle identifier, signed by this certificate" (`identifier "ing.lewisgo.openstems" and
  certificate leaf = H"..."`). Every release signed with the same certificate satisfies it,
  so the app's own updater works exactly as on Windows.
- **What it does not change.** Apple does not know the certificate. macOS still asks the
  user to allow the app before the first open, and there is no notarization. Only a
  Developer ID removes that. The hardened runtime stays off, as for the ad hoc build:
  without an Apple team it would refuse to load the app's own libraries.
- **The certificate.** `scripts/make-mac-cert.sh` makes it with openssl: an RSA 2048 key and
  a certificate for code signing only, valid for 20 years, as a `.p12`. It is stored as the
  repository secrets `CSC_LINK` (the `.p12` as base64) and `CSC_KEY_PASSWORD`, the same two
  names a Developer ID would use.
- **The release workflow** (`release-mac.yml`) tells the two kinds apart by the certificate
  itself: one that is its own issuer is self-signed (`scripts/mac-cert-kind.sh`). A secret
  that cannot be read with its password stops the release, rather than being taken for a
  Developer ID. OpenSSL 3 reads the certificate in the `.p12` only with `-legacy`, OpenSSL 1.1
  and LibreSSL only without it, so the script tries both; the CI test runs it on the Mac
  runner's own OpenSSL. For that one it tells the runner to
  trust the certificate for code signing (electron-builder lists only certificates the
  system trusts), sets `OPENSTEMS_SELF_SIGNED=1` and skips notarization.
- **The build configuration** (`app/mac-build.cjs`): with `CSC_LINK` and
  `OPENSTEMS_SELF_SIGNED=1` the app is signed with the certificate, without the hardened
  runtime and without notarization.
- **The app** (`canInstallUpdates` in `electron/updatelogic.ts`) reads `codesign`'s
  description of its own bundle at start. It updates itself when the first authority is a
  Developer ID, or when there is exactly one authority and it is not one of Apple's. Ad hoc
  (`Signature=adhoc`), unsigned and Apple development certificates keep the manual path.

## What was seen

On the Mac CI runner (macos-15, Apple Silicon), 2026-11-23, in the step "A self-signed Mac
app updates itself" (`app/scripts/mac-update-test.sh`, `app/e2e/mac-update.spec.ts`):

- A certificate made by the script signed the app through electron-builder once the runner
  trusted it. Before that `security find-identity -v` listed no valid identity.
- Two builds, 0.0.1 and 9.9.9, had the same designated requirement.
- The 0.0.1 app, started from a folder, found 9.9.9 on a local server, downloaded it, and
  after "restart" the installer replaced the bundle and started the new version. The
  bundle then read 9.9.9. This is the real updater, not a stand-in.

That step runs on every pull request, so a change that breaks it is caught. Since the
certificate is in the repository secrets it signs both builds with the project's own
certificate, through the same configuration and signing step as a release (a pull request
from a fork gets no secrets and uses a throwaway certificate instead). It also checks what
the installer checks, before the installer does: the newer build satisfies the older one's
designated requirement, and a copy signed ad hoc does not. The test builds are release
builds, GitHub as the update source included; only at run time is the app pointed at the
local server, with `OPENSTEMS_UPDATE_FEED`.

The requirement check and the update feed came from a second attempt at the same change,
made in parallel on 2026-11-23 (branch `mac-self-signed`, not merged). That attempt
re-signed the app with `codesign --deep` after electron-builder, on the belief that
electron-builder cannot use a self-signed certificate; it can, once the runner trusts it
(above), so the extra step was not taken over.

## The certificate

Made by the owner on the M1 Max on 2026-11-23, in Keychain Access (Certificate Assistant >
Create a Certificate: "Self Signed Root", "Code Signing"), named "OpenStems". SHA-1
fingerprint `86:E0:37:2E:33:92:92:DD:C7:9E:60:18:DB:42:49:0B:7D:FC:27:59`. It is in that
Mac's login keychain, in the owner's backup as a `.p12` with its password, and in the
repository secrets `CSC_LINK` and `CSC_KEY_PASSWORD`. Never in the repository.
`scripts/make-mac-cert.sh` makes an equivalent one where there is no Mac.

On 2026-11-23 the release step above ran once on the Mac runner with these secrets, building
only the app folder and publishing nothing: it took the certificate for self-signed, trusted
it, and electron-builder signed the app with it (`Authority=OpenStems`, valid). The
designated requirement was `identifier "ing.lewisgo.openstems" and certificate leaf =
H"86e0372e339292ddc79e6018db42490b7dfc2759"`.

## Not seen yet

- **A real release.** The first release signed this way has not been made. The secrets are
  set and were tried (above), so the next release is the first, if this change is in it.
- **On a Mac with a person at it.** The CI app was built there and never downloaded, so it
  carries no quarantine mark, and it ran from a folder, not from `/Applications`. An app
  from a dmg, allowed through System Settings, moved to Applications and then updated has
  not been tried. The owner's M1 Max is where to try it: install the first self-signed
  release from its dmg, then either wait for the next release, or serve a newer build from
  a folder (`python3 -m http.server 8000` in the folder that holds its zip and
  `latest-mac.yml`) and start the app with
  `OPENSTEMS_UPDATE_FEED=http://127.0.0.1:8000 /Applications/OpenStems.app/Contents/MacOS/OpenStems`.
- **Whether Gatekeeper asks again after an update.** Not known.

## Consequences

- **One more manual update.** Apps on 0.3.0 and 0.3.1 are ad hoc builds. They take the
  first self-signed release by hand, from the release page, and update themselves from the
  one after.
- **The key must be kept, and kept secret.** Lose it and a new certificate is needed, which
  no installed app accepts: everyone updates by hand once more. Anyone who has it can sign
  an update that installed apps accept, though they would also need to publish it on the
  project's releases. It lives in the repository secrets and in the owner's own safe copy,
  never in the repository.
- **A Developer ID later.** Moving to one is the same kind of change of signer: one manual
  update for everyone, then updates work again, with no warning at first open.
- **Windows is unchanged.**
