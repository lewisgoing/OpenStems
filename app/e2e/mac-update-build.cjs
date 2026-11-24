/**
 * The Mac build for the self-signed update test (`scripts/mac-update-test.sh`, CI only):
 * the release configuration (`mac-build.cjs`), GitHub as the update source included, with
 * two things changed so that two versions can be built side by side:
 *
 * - the version (`UPDATE_VERSION`), so there is an older build and a newer one;
 * - the folder the build goes to (`UPDATE_OUT`).
 *
 * The app is pointed at the local copy of the newer one when it runs, with
 * OPENSTEMS_UPDATE_FEED, the way the owner tries an update by hand on a Mac.
 */
const { macBuild } = require('../mac-build.cjs')

module.exports = () => {
  const { UPDATE_VERSION, UPDATE_OUT } = process.env
  if (!UPDATE_VERSION || !UPDATE_OUT) throw new Error('set UPDATE_VERSION and UPDATE_OUT')
  const config = macBuild(process.env)
  config.extraMetadata = { ...config.extraMetadata, version: UPDATE_VERSION }
  config.directories = { ...config.directories, output: UPDATE_OUT }
  return config
}
