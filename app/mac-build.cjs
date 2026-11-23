/**
 * The electron-builder configuration of the Mac build: the `build` block of package.json,
 * with one decision added. `pnpm dist:mac` and `pnpm pack:mac` read this file; the Windows
 * commands read package.json as they always did.
 *
 * With a Developer ID certificate (CSC_LINK) the block is used as it is: signed, hardened
 * runtime, notarized when the Apple variables are set too. Without one the app is signed
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
  return config
}

// electron-builder calls an exported function for the configuration.
module.exports = () => macBuild(process.env)
module.exports.macBuild = macBuild
