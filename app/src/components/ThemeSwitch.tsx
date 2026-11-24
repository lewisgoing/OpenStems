import { Monitor, Moon, Sun } from 'lucide-react'
import { Segmented } from '@/components/ui'
import { cn } from '@/lib/format'
import { type ThemePref, useThemePref } from '@/lib/theme'

const NAMES: Record<ThemePref, string> = { system: 'Match the system', light: 'Light', dark: 'Dark' }

/**
 * Light, dark or the system's, at the foot of the sidebar: three icons in one small track.
 * The thumb slides under a click, like every segmented control, and the page changes at
 * once (`applyTheme`). Nothing shows until the pick is known, so the thumb never jumps
 * from a guess to the saved one.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const [pref, setPref] = useThemePref()
  if (!pref) return null
  return (
    <Segmented
      label="Theme"
      value={pref}
      className={cn('theme-switch', className)}
      onChange={setPref}
      options={[
        { value: 'system', name: NAMES.system, hint: NAMES.system, label: <Monitor size={13} aria-hidden="true" /> },
        { value: 'light', name: NAMES.light, hint: NAMES.light, label: <Sun size={13} aria-hidden="true" /> },
        { value: 'dark', name: NAMES.dark, hint: NAMES.dark, label: <Moon size={13} aria-hidden="true" /> },
      ]}
    />
  )
}

/** The same pick in words, for Settings. */
export function ThemeSetting() {
  const [pref, setPref] = useThemePref()
  if (!pref) return null
  return (
    <Segmented
      label="Light or dark"
      value={pref}
      onChange={setPref}
      options={[
        { value: 'system', label: 'System', hint: NAMES.system },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ]}
    />
  )
}
