import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bridge } from './setup'
import { ThemeSetting, ThemeSwitch } from '@/components/ThemeSwitch'
import { STEM_PALETTE, paletteColor, stemColor } from '@/lib/format'
import { applyTheme, currentTheme } from '@/lib/theme'

afterEach(() => {
  delete document.documentElement.dataset.theme
})

/** WCAG contrast between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

describe('the theme switch', () => {
  it('shows the saved pick, and a click shows the other theme at once and saves it', async () => {
    render(
      <>
        <ThemeSwitch />
        <ThemeSetting />
      </>,
    )
    const sidebar = await screen.findByRole('radiogroup', { name: 'Theme' })
    expect(within(sidebar).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')

    act(() => {
      fireEvent.click(within(sidebar).getByRole('radio', { name: 'Light' }))
    })
    expect(currentTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(bridge.setShell).toHaveBeenLastCalledWith({ theme: 'light' })
    // The switch in Settings shows the same pick.
    const settings = screen.getByRole('radiogroup', { name: 'Light or dark' })
    expect(settings.querySelector('[aria-checked="true"]')).toHaveTextContent('Light')
  })

  it('leaves the theme to the main process under "Match the system"', async () => {
    applyTheme('dark')
    render(<ThemeSwitch />)
    await screen.findByRole('radiogroup', { name: 'Theme' })
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Match the system' }))
    })
    // Only the main process knows the system's theme: the page waits for its answer.
    expect(currentTheme()).toBe('dark')
    expect(bridge.setShell).toHaveBeenLastCalledWith({ theme: 'system' })
  })

  it('turns transitions off for the frame the colors change in', () => {
    applyTheme('light')
    expect(document.documentElement).toHaveClass('theme-switching')
  })
})

describe('stem colors on a light page', () => {
  it('are deep enough to see on the light background, and still tell stems apart', () => {
    const light = STEM_PALETTE.map((color) => paletteColor(color, 'light'))
    for (const color of light) expect(contrast(color, '#f7f8f9')).toBeGreaterThanOrEqual(3)
    expect(new Set(light).size).toBe(STEM_PALETTE.length)
  })

  it('are unchanged on a dark page', () => {
    expect(stemColor('vocals')).toBe('#f472b6')
    expect(stemColor('vocals', 'dark')).toBe('#f472b6')
    expect(stemColor('vocals', 'light')).toBe('#db2777')
    expect(stemColor('saxophone', 'light')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
