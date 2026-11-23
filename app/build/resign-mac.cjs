/**
 * electron-builder's `afterSign` hook for a Mac build signed with the project's own
 * certificate (`docs/adr/0014-macos.md`, "Signing").
 *
 * electron-builder signs only with a certificate the machine trusts, and a self-signed one
 * is not trusted on the build machine. So electron-builder signs ad hoc, and this hook signs
 * the app again with the certificate, before the dmg and the zip are made. `codesign` itself
 * accepts the certificate. The signature then names it, and the app's designated requirement
 * pins it: that is what lets one version install the next (Squirrel.Mac checks the new app
 * against the running one's requirement).
 *
 * It does something only when OPENSTEMS_SIGN_IDENTITY (the certificate's SHA-1, as
 * `security find-identity` prints it) is set; OPENSTEMS_SIGN_KEYCHAIN names the keychain
 * that holds it. `build/import-mac-cert.sh` sets both in CI.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

/** The `codesign` arguments that sign `appPath` again with `identity`. */
function resignArgs(appPath, identity, keychain) {
  // --deep reaches the frameworks and helpers inside, so every part names the same signer.
  // The entitlements are kept; the requirement is not, so it is made from the certificate.
  const args = ['--force', '--deep', '--sign', identity, '--timestamp=none', '--preserve-metadata=entitlements']
  if (keychain) args.push('--keychain', keychain)
  args.push(appPath)
  return args
}

/** The hook. `env` and `run` are passed in by the tests. */
async function afterSign(context, env = process.env, run = execFileSync) {
  if (context.electronPlatformName !== 'darwin') return
  const identity = env.OPENSTEMS_SIGN_IDENTITY
  if (!identity) return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  run('/usr/bin/codesign', resignArgs(appPath, identity, env.OPENSTEMS_SIGN_KEYCHAIN), { stdio: 'inherit' })
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}

module.exports = afterSign
module.exports.default = afterSign
module.exports.afterSign = afterSign
module.exports.resignArgs = resignArgs
