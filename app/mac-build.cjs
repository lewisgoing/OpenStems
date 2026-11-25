/**
 * The electron-builder configuration of the Mac build: the `build` block of package.json,
 * with one decision added. `pnpm dist:mac` and `pnpm pack:mac` read this file; the Windows
 * commands read package.json as they always did.
 *
 * With a Developer ID certificate (CSC_LINK) the block is used as it is: signed, hardened
 * runtime, notarized when the Apple variables are set too.
 *
 * With a certificate the project made itself (CSC_LINK, and OPENSTEMS_SELF_SIGNED=1 to say
 * which kind it is) the app is signed with it, so every release has the same signer and an
 * installed app can update itself. Apple knows nothing of such a certificate: there is no
 * notarization, and the hardened runtime is off, because without an Apple team it would
 * refuse to load the app's own libraries, as it does for an ad hoc signature.
 *
 * Without a certificate the app is signed
 * ad hoc. electron-builder would otherwise leave it with no valid signature at all (it
 * edits the bundle Electron signed), and macOS delivers notifications only for an app that
 * has one. An ad hoc signature names nobody: macOS still asks before the first open, and
 * the app still cannot install an update. The hardened runtime is off there, because with
 * an ad hoc signature it would refuse to load the app's own libraries.
 */
const { build } = require('./package.json')

/** The configuration for an environment: `env` is `process.env`, passed in for the tests. */
function macBuild(env) {
  // A copy: electron-builder changes the configuration it is given.
  const config = structuredClone(build)
  if (!env.CSC_LINK) config.mac = { ...config.mac, identity: '-', hardenedRuntime: false }
  else if (env.OPENSTEMS_SELF_SIGNED === '1') config.mac = { ...config.mac, hardenedRuntime: false, notarize: false }
  return config
}

// electron-builder calls an exported function for the configuration.
module.exports = () => macBuild(process.env)
module.exports.macBuild = macBuild
