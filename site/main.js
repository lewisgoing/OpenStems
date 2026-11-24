// OpenStems site. No dependencies, no third-party requests except GitHub's release API.
'use strict'

const REPO = 'lewisgoing/OpenStems'
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

/* ------------------------------------------------------------------ */
/* Waveforms: an invented 8-bar groove at 128 bpm, drawn per stem.     */
/* No audio is used; every shape comes from a seeded generator.        */
/* ------------------------------------------------------------------ */

const BEATS = 32
const PER_BEAT = 6
const COLS = BEATS * PER_BEAT

function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A hit at `beat` that decays over `len` beats. */
function hit(col, beat, peak, len) {
  const b = col / PER_BEAT - beat
  return b < 0 || b > len ? 0 : peak * Math.exp((-b / len) * 4)
}

function build() {
  const r = rng(7)
  const n = (amt) => 1 - amt + r() * amt
  const s = {}
  const each = (fn) => Array.from({ length: COLS }, (_, c) => fn(c))

  s.kick = each((c) => {
    let v = 0
    for (let b = 0; b < BEATS; b++) if (!(b >= 14 && b < 16)) v = Math.max(v, hit(c, b, 0.95, 0.5))
    return v * n(0.1)
  })
  s.snare = each((c) => {
    let v = 0
    for (let b = 1; b < BEATS; b += 2) v = Math.max(v, hit(c, b, 0.8, 0.45))
    return v * n(0.15)
  })
  s.toms = each((c) => {
    let v = 0
    for (const b of [14, 14.5, 15, 15.25, 15.5, 15.75, 30.5, 31, 31.5]) v = Math.max(v, hit(c, b, 0.75, 0.4))
    return v * n(0.2)
  })
  s.hh = each((c) => {
    let v = 0
    for (let b = 0; b < 16; b += 0.5) v = Math.max(v, hit(c, b + 0.5, 0.42, 0.3))
    return v * n(0.35)
  })
  s.ride = each((c) => {
    let v = 0
    for (let b = 16; b < BEATS; b += 1) v = Math.max(v, hit(c, b + 0.5, 0.4, 0.8))
    return v * n(0.3)
  })
  s.crash = each((c) => Math.max(hit(c, 0, 0.7, 3.5), hit(c, 16, 0.75, 4)) * n(0.25))
  s.drums = each((c) => Math.min(1, s.kick[c] + s.snare[c] * 0.8 + s.toms[c] * 0.8 + s.hh[c] * 0.5 + s.ride[c] * 0.5 + s.crash[c] * 0.6))

  s.bass = each((c) => {
    const beat = c / PER_BEAT
    if (beat < 4) return 0.02
    const note = Math.floor(beat * 2) / 2
    const into = beat - note
    return (0.42 + 0.22 * Math.sin(note * 1.7)) * (into < 0.05 ? 0.6 : 1 - into * 0.5) * n(0.12)
  })
  s.vocals = each((c) => {
    const beat = c / PER_BEAT
    const phrases = [[4, 7.5], [8, 11.5], [12, 15], [20, 23.5], [24, 27.5], [28, 31.5]]
    const p = phrases.find(([a, b]) => beat >= a && beat < b)
    if (!p) return 0.02 * r()
    const syll = Math.abs(Math.sin((beat - p[0]) * Math.PI * 2.2))
    const edge = Math.min(1, (beat - p[0]) * 4, (p[1] - beat) * 3)
    return (0.25 + 0.55 * syll) * edge * n(0.25)
  })
  s.guitar = each((c) => {
    const beat = c / PER_BEAT
    if (beat < 8) return 0.03
    return hit(c, Math.floor(beat * 2) / 2, 0.5, 0.45) * (beat >= 16 ? 1 : 0.7) * n(0.3)
  })
  s.piano = each((c) => {
    const beat = c / PER_BEAT
    let v = 0
    for (let b = 0; b < BEATS; b += 4) v = Math.max(v, hit(c, b, 0.62, 3.6))
    return v * (beat >= 16 && beat < 24 ? 0.35 : 1) * n(0.15)
  })
  s.other = each((c) => {
    const beat = c / PER_BEAT
    return (0.18 + 0.14 * Math.sin(beat / 5) + (beat >= 16 ? 0.12 : 0)) * n(0.2)
  })
  s.mix = each((c) =>
    Math.min(0.98, 0.18 + 0.62 * (s.vocals[c] + s.drums[c] * 0.9 + s.bass[c] + s.guitar[c] * 0.6 + s.piano[c] * 0.6 + s.other[c] * 0.6) / 2.4),
  )
  return s
}

/** Mirrored bars as one path: crisp at any size with preserveAspectRatio="none". */
function wavePath(values) {
  const w = 4
  let d = ''
  values.forEach((v, i) => {
    const h = Math.max(1.2, v * 96)
    const y = 50 - h / 2
    d += `M${i * w + 0.5} ${y.toFixed(2)}h${w - 1.6}v${h.toFixed(2)}h-${w - 1.6}z`
  })
  return `<svg viewBox="0 0 ${values.length * w} 100" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`
}

function drawWaves(stems) {
  for (const el of document.querySelectorAll('[data-wave]')) {
    const values = stems[el.dataset.wave]
    if (values) el.innerHTML = wavePath(values)
  }
}

/* ------------------------------------------------------------------ */
/* How it works: the separation, scrubbed by scroll                    */
/* ------------------------------------------------------------------ */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
// The site's ease-in-out, (0.77, 0, 0.175, 1), approximated for scrubbing.
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

function setupHow() {
  const section = document.getElementById('how')
  if (!section) return
  const mix = document.getElementById('mix')
  const lanes = [...section.querySelectorAll('.lane')]
  const names = lanes.map((l) => l.querySelector('.lane-name'))
  const drags = lanes.map((l) => l.querySelector('.drag'))
  const steps = [...section.querySelectorAll('.steps li')]
  const pct = document.getElementById('pct')
  const mid = (lanes.length - 1) / 2

  function paint(p) {
    // 0 to 0.1: the mix as dropped. 0.1 to 0.6: it comes apart. 0.6 on: names and handles.
    mix.style.opacity = String(1 - clamp((p - 0.1) / 0.22))
    mix.style.transform = `scaleY(${1 - 0.25 * easeInOut(clamp((p - 0.1) / 0.3))})`
    lanes.forEach((lane, i) => {
      const a = easeInOut(clamp((p - 0.12 - i * 0.03) / 0.36))
      const y = (mid - i) * 100 * (1 - a)
      const s = 1 + 1.6 * (1 - a)
      lane.style.transform = `translateY(${y.toFixed(2)}%) scaleY(${s.toFixed(3)})`
      const label = easeOut(clamp((p - 0.56 - i * 0.025) / 0.1))
      names[i].style.opacity = String(label)
      names[i].style.transform = `translateX(${((1 - label) * -6).toFixed(2)}px) scaleY(${(1 / s).toFixed(3)})`
      const handle = easeOut(clamp((p - 0.72 - i * 0.025) / 0.1))
      drags[i].style.opacity = String(handle)
      drags[i].style.transform = `translateX(${((1 - handle) * 8).toFixed(2)}px) scaleY(${(1 / s).toFixed(3)})`
    })
    const step = p < 0.1 ? 0 : p < 0.66 ? 1 : 2
    steps.forEach((li, i) => li.classList.toggle('on', reduceMotion.matches || i === step))
    pct.textContent = String(Math.round(clamp((p - 0.12) / 0.5) * 100))
  }

  let frame = 0
  function update() {
    frame = 0
    if (reduceMotion.matches) return paint(1)
    const rect = section.getBoundingClientRect()
    const travel = rect.height - innerHeight
    paint(travel > 0 ? clamp(-rect.top / travel) : 1)
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
  addEventListener('scroll', schedule, { passive: true })
  addEventListener('resize', schedule)
  reduceMotion.addEventListener('change', schedule)
  update()
}

/** The support button shows once index.html gives it an address. */
function setupSupport() {
  const link = document.getElementById('support-link')
  if (!link.getAttribute('href')) return
  link.hidden = false
  document.getElementById('support-soon').hidden = true
}

/* ------------------------------------------------------------------ */
/* Will it run: the README's Memory table. Groups, in order: the main  */
/* recipes, the larger vocal models, cleanup, mega-53.                 */
/* ------------------------------------------------------------------ */

const F = 'fits'
const T = 'tight'
const N = 'no'
const CARD_NOTE = 'Measured on an RTX 5070 Ti. The figures for other sizes follow from those measurements.'
const MACHINES = {
  nvidia: {
    hint: 'NVIDIA GTX 16 series, RTX 20 series and later',
    pick: '8',
    sizes: { '4': [F, T, F, N], '6': [F, F, F, N], '8': [F, F, F, N], '10–11': [F, F, F, T], '12+': [F, F, F, F] },
    note: () => CARD_NOTE,
  },
  amd: {
    hint: 'AMD Radeon RX 9000 series, RX 7900 XTX, RX 7700 and pro cards',
    pick: '16+',
    sizes: { '8': [F, F, F, N], '12': [F, F, F, F], '16+': [F, F, F, F] },
    note: () =>
      'Supported cards: RX 9070, RX 9070 XT, RX 9060 XT, RX 7900 XTX, RX 7700, PRO W7900 and AI PRO R9700, with AMD driver 26.2.2 or newer. AMD support is a preview: a user has reported it working, but it has not been tested on a Radeon by the project. Older Radeons and integrated graphics run on the processor, slowly.',
  },
  mac: {
    hint: 'Apple Silicon, M1 or later, macOS 14 or later',
    pick: '16',
    sizes: { '8': [T, N, F, N], '16': [F, F, F, N], '24': [F, F, F, N], '32+': [F, F, F, F] },
    budget: (gb) => `The app plans with about ${((gb - 2) * 0.75).toFixed(1).replace(/\.0$/, '')} GB of it: macOS and your other apps share the rest.`,
    note: () =>
      'Estimates: nothing has been measured on a Mac yet, so it may do better than this. Tested on an M1 Max with 32 GB so far.',
  },
  pascal: {
    hint: 'NVIDIA GTX 900 and 10 series',
    pick: '8',
    sizes: { '4': [T, N, F, N], '6': [F, N, F, N], '8': [F, T, F, N], '11': [F, F, F, N] },
    verdict: (size) => (size === '4' ? 'Only just, if at all.' : undefined),
    note: (size) =>
      (size === '4'
        ? 'At 4 GB the main recipes are estimated at 3.99 GB, and a card reports a little under 4, so the app will most likely mark them too large. They can still be run. '
        : '') +
      'These cards get a build of their own, untested so far. They run the models at full precision, which needs more memory, so these figures are estimates.',
  },
  other: {
    hint: 'Intel Mac, Intel graphics, older Radeon, no graphics card',
    note: () =>
      'Intel Macs are not supported: PyTorch has no build for them. On Windows, without a graphics card from the list, separation runs on the processor: the same stems, many times slower.',
  },
}
const WORDS = { [F]: 'fits', [T]: 'tight', [N]: 'too large' }

function setupRun() {
  const machineKeys = [...document.querySelectorAll('#machine-keys button')]
  const memoryBox = document.getElementById('memory-keys')
  const memoryLabel = document.getElementById('memory-label')
  const hint = document.getElementById('machine-hint')
  const groups = [...document.querySelectorAll('#run-table > div')]
  const table = document.getElementById('run-table')
  const verdict = document.getElementById('run-verdict')
  const budget = document.getElementById('run-budget')
  const note = document.getElementById('run-note')
  const always = document.getElementById('run-always')
  let machine = 'nvidia'
  let size = MACHINES.nvidia.pick

  const press = (keys, on) => keys.forEach((k) => k.setAttribute('aria-pressed', String(k === on)))

  function render() {
    const m = MACHINES[machine]
    press(machineKeys, machineKeys.find((k) => k.dataset.machine === machine))
    hint.textContent = m.hint
    memoryBox.replaceChildren()
    memoryLabel.hidden = memoryBox.hidden = !m.sizes
    if (m.sizes) {
      for (const label of Object.keys(m.sizes)) {
        const key = document.createElement('button')
        key.type = 'button'
        key.className = 'press'
        key.textContent = label
        key.addEventListener('click', () => { size = label; render() })
        memoryBox.append(key)
      }
      press([...memoryBox.children], [...memoryBox.children].find((k) => k.textContent === size))
    }

    const row = m.sizes?.[size]
    table.hidden = always.hidden = !row
    row?.forEach((f, i) => {
      groups[i].dataset.fit = f
      groups[i].querySelector('.state').textContent = WORDS[f]
    })
    const [main, larger] = row ?? []
    verdict.textContent = m.verdict?.(size) ?? (!row
      ? 'On the processor, slowly. Not at all on an Intel Mac.'
      : row.every((f) => f === F)
        ? 'Yes. Every recipe fits.'
        : main === F && larger === F
          ? (row[3] === T ? 'Yes. Everything fits, the 53-stem model only just.' : 'Yes. Everything but the 53-stem model fits.')
          : main === F
            ? 'Yes. The main recipes fit.'
            : 'Yes, with little to spare.')
    budget.textContent = m.budget ? m.budget(parseInt(size, 10)) : ''
    budget.hidden = !m.budget
    note.textContent = m.note(size)
  }

  machineKeys.forEach((key) =>
    key.addEventListener('click', () => {
      machine = key.dataset.machine
      const sizes = MACHINES[machine].sizes
      if (sizes && !(size in sizes)) size = MACHINES[machine].pick
      render()
    }),
  )
  render()
}
/* ------------------------------------------------------------------ */
/* Reveal on scroll, once                                              */
/* ------------------------------------------------------------------ */

function setupReveal() {
  const targets = [...document.querySelectorAll('.reveal, .reveal-group, .how')].filter((t) => !t.classList.contains('in'))
  if (!('IntersectionObserver' in window)) return targets.forEach((t) => t.classList.add('in'))
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
  )
  targets.forEach((t) => io.observe(t))
}

/* ------------------------------------------------------------------ */
/* Releases: the newest from GitHub, links stay on /releases/latest    */
/* until it answers                                                    */
/* ------------------------------------------------------------------ */

const fill = (key, text) => document.querySelectorAll(`[data-fill="${key}"]`).forEach((el) => { el.textContent = text })
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

let versionFromApi = false
function showVersion(v, fromApi = false) {
  fill('version', v)
  if (fromApi) versionFromApi = true
}

async function loadRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(String(res.status))
    const rel = await res.json()
    const version = String(rel.tag_name).replace(/^v/, '')
    showVersion(version, true)
    fill('released', `${version}, ${day(rel.published_at)}`)
    const win = rel.assets.find((a) => /^OpenStems-Setup-.*\.exe$/.test(a.name))
    const mac = rel.assets.find((a) => /-arm64\.dmg$/.test(a.name))
    if (win) {
      document.getElementById('dl-win').href = win.browser_download_url
      fill('win-meta', `.exe · ${mb(win.size)}`)
    }
    if (mac) {
      document.getElementById('dl-mac').href = mac.browser_download_url
      fill('mac-meta', `.dmg · ${mb(mac.size)}`)
    } else {
      // release-mac.yml adds the Mac files a little after a release is published
      fill('mac-meta', 'building')
      const note = document.createElement('p')
      note.className = 'notice'
      note.textContent = `The Mac build of ${version} is still being made. The link opens the release page; it appears there within the hour.`
      document.getElementById('dl-mac').after(note)
    }
  } catch {
    // The links already point at the latest release page.
  }
}

/* ------------------------------------------------------------------ */
/* Changelog: CHANGELOG.md from this site, the newest few versions     */
/* ------------------------------------------------------------------ */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text) {
  return text
    .split('`')
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part)}</code>`
      return esc(part)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
          const href = /^https?:/.test(url) ? url : `https://github.com/${REPO}/blob/main/${url.replace(/^\.?\//, '')}`
          return `<a href="${href}">${label}</a>`
        })
    })
    .join('')
}

/** `## 0.4.0 (2026-11-24)` sections with `- ` bullets whose lines wrap with two spaces. */
function parseChangelog(md) {
  const releases = []
  let current = null
  let bullet = null
  for (const raw of md.split(/\r?\n/)) {
    const head = raw.match(/^## (\S+)(?: \(([^)]+)\))?/)
    if (head) {
      current = { version: head[1], date: head[2] ?? '', items: [] }
      releases.push(current)
      bullet = null
      continue
    }
    if (!current) continue
    if (/^### /.test(raw)) { current.items.push({ kind: 'head', text: raw.slice(4) }); bullet = null; continue }
    if (/^- /.test(raw)) { bullet = { kind: 'li', text: raw.slice(2) }; current.items.push(bullet); continue }
    if (/^\s+\S/.test(raw) && bullet) { bullet.text += ' ' + raw.trim(); continue }
    if (raw.trim()) { bullet = { kind: 'p', text: raw.trim() }; current.items.push(bullet); continue }
    bullet = null
  }
  return releases
}

function renderItems(items) {
  let html = ''
  let open = false
  for (const it of items) {
    if (it.kind === 'li') { if (!open) { html += '<ul>'; open = true } html += `<li>${inline(it.text)}</li>` }
    else { if (open) { html += '</ul>'; open = false } html += it.kind === 'head' ? `<p class="mono" style="margin:14px 0 8px;color:var(--ink)">${inline(it.text)}</p>` : `<p style="color:var(--muted);margin-bottom:8px">${inline(it.text)}</p>` }
  }
  return html + (open ? '</ul>' : '')
}

async function loadChangelog() {
  const log = document.getElementById('log')
  try {
    const res = await fetch('CHANGELOG.md')
    if (!res.ok) throw new Error(String(res.status))
    const releases = parseChangelog(await res.text()).slice(0, 6)
    if (!releases.length) return
    if (!versionFromApi) showVersion(releases[0].version)
    log.innerHTML = releases
      .map((r, i) => {
        const count = r.items.filter((it) => it.kind === 'li').length
        const body = i === 0
          ? renderItems(r.items)
          : `<details><summary class="press">${count} ${count === 1 ? 'change' : 'changes'} <span class="mono">show</span></summary>${renderItems(r.items)}</details>`
        return `<article class="release reveal" style="--i:${Math.min(i, 4)}">
          <div class="release-id">
            <p class="v">${esc(r.version)}</p>
            <time class="mono" datetime="${esc(r.date)}">${esc(r.date)}</time>
            ${i === 0 ? '<span class="latest mono">latest</span>' : ''}
          </div>
          <div>${body}</div>
        </article>`
      })
      .join('')
    setupReveal()
  } catch {
    // The fallback paragraph links to the file on GitHub.
  }
}

/* ------------------------------------------------------------------ */

drawWaves(build())
setupSupport()
setupRun()
setupHow()
setupReveal()
loadChangelog()
loadRelease()
