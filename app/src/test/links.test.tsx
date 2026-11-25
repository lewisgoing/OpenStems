import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { REPOSITORY, SITE_SECTIONS, WEBSITE, siteLink } from '../../electron/links'
import { AboutSettings, MemoryRow } from '@/views/SettingsView'
import { RELEASES_URL } from '../../electron/updatelogic'
import { bridge } from './setup'

describe('the addresses the app opens', () => {
  it('are the website, its sections and the repository', () => {
    expect(WEBSITE).toBe('https://lewisgoing.github.io/OpenStems/')
    expect(siteLink()).toBe(WEBSITE)
    expect(siteLink('changelog')).toBe('https://lewisgoing.github.io/OpenStems/#changelog')
    expect(siteLink('run')).toBe('https://lewisgoing.github.io/OpenStems/#run')
    expect(siteLink('support')).toBe('https://lewisgoing.github.io/OpenStems/#support')
    expect(REPOSITORY).toBe('https://github.com/lewisgoing/OpenStems')
  })

  it('name only sections the page has', () => {
    // An installed app keeps its links for good, so an anchor renamed on the site fails here.
    const page = readFileSync(resolve(__dirname, '../../../site/index.html'), 'utf8')
    for (const anchor of Object.values(SITE_SECTIONS)) {
      expect(page, `site/index.html has no section with id="${anchor}"`).toMatch(new RegExp(`<section[^>]* id="${anchor}"`))
    }
  })

  it('leave the update link on the release itself, where the files are', () => {
    expect(RELEASES_URL).toBe(`${REPOSITORY}/releases/latest`)
  })
})

describe('About, in Settings', () => {
  const link = (name: string | RegExp) => screen.getByRole('link', { name })

  it('links to the website, the changelog and the support section, each in the browser', () => {
    render(<AboutSettings engineVersion="0.4.1" />)
    expect(link('Open the website')).toHaveAttribute('href', WEBSITE)
    expect(link('Read the changelog')).toHaveAttribute('href', siteLink('changelog'))
    expect(link('Support')).toHaveAttribute('href', siteLink('support'))
    expect(link('Source on GitHub')).toHaveAttribute('href', REPOSITORY)
    // A new window is what the main process sends to the browser; a plain link would be refused.
    for (const a of screen.getAllByRole('link')) expect(a).toHaveAttribute('target', '_blank')
    expect(screen.getByText(/OpenStems 0\.0\.0-test · engine 0\.4\.1/)).toBeInTheDocument()
  })

  it('says the same on a Mac: the links are not platform words', () => {
    bridge.info.platform = 'darwin'
    render(<AboutSettings engineVersion="0.4.1" />)
    expect(link('Open the website')).toHaveAttribute('href', WEBSITE)
    expect(link('Support')).toHaveAttribute('href', siteLink('support'))
    bridge.info.platform = 'win32'
  })
})

describe('the memory row', () => {
  it('links to what fits on which machine', () => {
    render(<MemoryRow machine={{ budget: 6, total: 6, kind: 'card', overridden: false }} />)
    expect(screen.getByRole('link', { name: 'What fits on which machine' })).toHaveAttribute('href', siteLink('run'))
  })
})
