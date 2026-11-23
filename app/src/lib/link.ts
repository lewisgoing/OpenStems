/** The web address in a piece of text, if the text starts with one. */
export function linkFrom(text: string | null | undefined): string | null {
  const candidate = (text ?? '').trim().split(/\s+/)[0] ?? ''
  if (!/^https?:\/\/\S+\.\S+/i.test(candidate)) return null
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/** The site a link points at, without `www.`: what to call a song before its title is known. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
