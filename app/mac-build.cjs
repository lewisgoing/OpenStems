/**
 * The electron-builder configuration of the Mac build: the `build` block of package.json,
 * with one decision added. `pnpm dist:mac` and `pnpm pack:mac` read this file; the Windows
 * commands read package.json as they always did.
 *
 * With a Developer ID certificate (CSC_LINK) the block is used as it is: signed, hardened
 * runtime, notarized when the Apple variables are set too. Without one the app is signed
 * ad hoc. electron-builder would otherwise leave it with no valid signature at all (it
 * edits the bundle Electron signed), and macOS delivers notifications only for an app that
 * has one. The hardened runtime is off there, because without a Developer ID (and its Team
 * ID) it would refuse to load the app's own libraries.
 *
 * With OPENSTEMS_SIGN_IDENTITY as well (the project's own, self-signed certificate,
 * imported by `build/import-mac-cert.sh`), `build/resign-mac.cjs` signs the app again with
 * it before the dmg and zip are made. macOS still asks before the first open, since it does
 * not know the certificate, but each version can install the next: the signature names the
 * same signer every time. An ad hoc signature names nobody, so it cannot.
 */
const { build } = require('./package.json')

/** The configuration for an environment: `env` is `process.env`, passed in for the tests. */
function macBuild(env) {
  // A copy: electron-builder changes the configuration it is given.
  const config = structuredClone(build)
  if (!env.CSC_LINK) {
    config.mac = { ...config.mac, identity: '-', hardenedRuntime: false }
    if (env.OPENSTEMS_SIGN_IDENTITY) config.afterSign = 'build/resign-mac.cjs'
  }
  return config
}

// electron-builder calls an exported function for the configuration.
module.exports = () => macBuild(process.env)
module.exports.macBuild = macBuild
