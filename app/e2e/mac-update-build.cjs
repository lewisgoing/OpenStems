/**
 * The Mac build for the self-signed update test (`scripts/mac-update-test.sh`, CI only):
 * the release configuration (`mac-build.cjs`) with three things changed, so that two
 * versions can be built side by side and one can find the other.
 *
 * - the version (`UPDATE_VERSION`), so there is an older build and a newer one;
 * - where the app looks for updates (`UPDATE_FEED`): a folder served on this machine, in
 *   place of the GitHub releases. It is written into the bundle before it is signed;
 * - the folder the build goes to (`UPDATE_OUT`).
 */
const { macBuild } = require('../mac-build.cjs')

module.exports = () => {
  const { UPDATE_VERSION, UPDATE_FEED, UPDATE_OUT } = process.env
  if (!UPDATE_VERSION || !UPDATE_FEED || !UPDATE_OUT) throw new Error('set UPDATE_VERSION, UPDATE_FEED and UPDATE_OUT')
  const config = macBuild(process.env)
  config.extraMetadata = { ...config.extraMetadata, version: UPDATE_VERSION }
  config.publish = [{ provider: 'generic', url: UPDATE_FEED }]
  config.directories = { ...config.directories, output: UPDATE_OUT }
  return config
}
