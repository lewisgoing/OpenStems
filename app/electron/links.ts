/**
 * The addresses the app opens in the browser, in one place. No Node or Electron imports: the
 * main process (the Mac Help menu) and the renderer (Settings) both read it.
 *
 * The website is one page, and each section has an anchor. Those anchors are public
 * addresses (`docs/site.md`): a test checks that every one named here is on the page.
 */

export const WEBSITE = 'https://lewisgoing.github.io/OpenStems/'
export const REPOSITORY = 'https://github.com/lewisgoing/OpenStems'

/** The sections of the website the app links to, by their anchors on the page. */
export const SITE_SECTIONS = {
  /** What changed in each version. */
  changelog: 'changelog',
  /** Which recipes fit on which machine. */
  run: 'run',
  /** The Ko-fi button, and other ways to help. */
  support: 'support',
} as const

export type SiteSection = keyof typeof SITE_SECTIONS

/** The website, or one section of it. */
export function siteLink(section?: SiteSection): string {
  return section ? `${WEBSITE}#${SITE_SECTIONS[section]}` : WEBSITE
}
