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
  // every-stem's split of the vocals, and what DrumSep leaves of the drums
  s.lead = each((c) => s.vocals[c] * 0.92)
  s.backing = each((c) => {
    const beat = c / PER_BEAT
    return (beat >= 12 && beat < 15) || (beat >= 28 && beat < 31.5) ? s.vocals[c] * 0.55 : 0.015
  })
  s.otherdrums = each((c) => (0.05 + 0.07 * r()) * (s.drums[c] > 0.4 ? 1.6 : 1))
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
    hint: 'GTX 16 series, RTX 20 series and later',
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
    hint: 'GTX 900 and 10 series',
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
/* Every stem: wires between the passes, drawn in when the chain is   */
/* first seen; "Sum to mix" folds the 13 lanes into the song          */
/* ------------------------------------------------------------------ */

// [from, to, depth (when it draws), kind]: "model" between passes, "out" to a stem
const WIRES = [
  ['song', 'vox', 0, 'model'], ['song', 'sw', 0, 'model'],
  ['vox', 'split', 1, 'down'], ['sw', 'kit', 1, 'down'],
  ['split', 'lead', 2, 'out'], ['split', 'backing', 2, 'diff'],
  ['sw', 'bass', 2, 'out'], ['sw', 'guitar', 2, 'out'], ['sw', 'piano', 2, 'out'], ['sw', 'other', 2, 'out'],
  ['kit', 'kick', 3, 'out'], ['kit', 'snare', 3, 'out'], ['kit', 'toms', 3, 'out'], ['kit', 'hh', 3, 'out'],
  ['kit', 'ride', 3, 'out'], ['kit', 'crash', 3, 'out'], ['kit', 'otherdrums', 3, 'diff'],
]

function setupChain() {
  const chain = document.getElementById('chain')
  const svg = document.getElementById('wires')
  if (!chain || !svg) return
  const node = (id) => chain.querySelector(`[data-node="${id}"]`)

  function draw() {
    const box = chain.getBoundingClientRect()
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
    const at = (el) => {
      const r = el.getBoundingClientRect()
      return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, m: r.top - box.top + r.height / 2 }
    }
    svg.innerHTML = WIRES.map(([from, to, depth, kind]) => {
      const a = at(node(from))
      const b = at(node(to))
      let d
      if (kind === 'down') {
        const x = a.l + 18
        d = `M${x} ${a.b} L${x} ${b.t}`
      } else {
        const x1 = a.r
        const x2 = b.l - 10
        const dx = (x2 - x1) * 0.5
        d = `M${x1} ${a.m} C${x1 + dx} ${a.m}, ${x2 - dx} ${b.m}, ${x2} ${b.m}`
      }
      const color = kind === 'out' || kind === 'diff' ? getComputedStyle(node(to)).getPropertyValue('--c') : ''
      return `<path class="wire wire-${kind}" style="--d:${depth}${color ? `;stroke:${color}` : ''}" d="${d}"/>`
    }).join('')
    for (const path of svg.querySelectorAll('path')) {
      const len = Math.ceil(path.getTotalLength())
      path.style.strokeDasharray = path.classList.contains('wire-diff') ? '3 4' : `${len} ${len}`
      path.style.setProperty('--len', String(len))
    }
  }

  draw()
  let frame = 0
  addEventListener('resize', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw) })
  document.fonts?.ready.then(draw)
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { chain.classList.add('in'); io.disconnect() }
  }, { threshold: 0.25 })
  io.observe(chain)
}

/** The hero's windows: Queue, Studio, Tray, one at a time. */
const SHOT_SAY = [
  'Songs separate in order, and their stems drag straight out.',
  'Cut a part on the bar grid and drag it out as a clip.',
  'Drop a song on the tray icon without opening the window.',
]
function setupShots() {
  const buttons = [...document.querySelectorAll('[data-shot]')]
  const imgs = [...document.querySelectorAll('.shots img')]
  const say = document.getElementById('shot-say')
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.shot)
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      imgs.forEach((img, j) => img.classList.toggle('on', j === i))
      say.textContent = SHOT_SAY[i]
    })
  }
}

// every-stem's 13 outputs, in groups, with the color token each is drawn in
const SUM_LANES = [
  [['lead', 'lead vocals', 'vocals'], ['backing', 'backing vocals', 'backing']],
  [['kick', 'kick', 'kick'], ['snare', 'snare', 'snare'], ['toms', 'toms', 'toms'], ['hh', 'hi-hat', 'hh'],
    ['ride', 'ride', 'ride'], ['crash', 'crash', 'crash'], ['otherdrums', 'other drums', 'otherdrums']],
  [['bass', 'bass', 'bass']],
  [['guitar', 'guitar', 'guitar'], ['piano', 'piano', 'piano'], ['other', 'other', 'other']],
]

/**
 * One canvas: 13 lanes, each bar in its stem's color. Summed, every column's bars slide
 * into one stack, so the song's waveform is visibly made of the 13 parts.
 */
function setupSum(stems) {
  const toggle = document.getElementById('sum-toggle')
  const read = document.getElementById('sum-read')
  const canvas = document.getElementById('sum-canvas')
  if (!toggle || !canvas) return
  const ctx = canvas.getContext('2d')
  const css = getComputedStyle(document.documentElement)
  const lanes = SUM_LANES.flatMap((group, g) =>
    group.map(([key, label, token]) => ({ key, label, g, color: css.getPropertyValue(`--${token}`).trim() || '#ccc' })),
  )
  const muted = css.getPropertyValue('--muted').trim() || '#8d9098'
  const ink = css.getPropertyValue('--ink').trim() || '#ecebe6'

  let t = 0 // 0: lanes, 1: summed
  let target = 0
  let last = 0
  let frame = 0

  function paint() {
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const labelW = w < 560 ? 86 : 132
    const gap = 14
    const laneH = (h - gap * (SUM_LANES.length - 1)) / lanes.length
    const x0 = labelW
    const plotW = w - x0
    const step = plotW / COLS < 3 ? 2 : 1 // fold columns in pairs on a phone
    const cols = Math.floor(COLS / step)
    const colW = plotW / cols
    const barW = Math.max(1, colW - (colW > 4 ? 1.6 : 0.8))
    const value = (key, c) => {
      const v = stems[key]
      return step === 1 ? v[c] : Math.max(v[c * 2], v[c * 2 + 1])
    }
    const laneMid = (i) => i * laneH + lanes[i].g * gap + laneH / 2

    // the scale of the stack: the tallest column fills the height
    let most = 0
    const totals = new Float32Array(cols)
    for (let c = 0; c < cols; c++) {
      let sum = 0
      for (const l of lanes) sum += value(l.key, c)
      totals[c] = sum
      most = Math.max(most, sum)
    }
    const k = (h - 12) / most

    // labels and baselines fade as the lanes leave
    const away = easeInOut(clamp(t * 1.6))
    ctx.font = `${w < 560 ? 10 : 11}px "JetBrains Mono", ui-monospace, monospace`
    ctx.textBaseline = 'middle'
    lanes.forEach((l, i) => {
      const y = laneMid(i)
      ctx.globalAlpha = 1 - away
      ctx.fillStyle = l.color
      ctx.beginPath()
      ctx.arc(4, y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = muted
      ctx.fillText(l.label, 14, y)
      ctx.globalAlpha = 0.09 * (1 - away)
      ctx.fillStyle = ink
      ctx.fillRect(x0, Math.round(y), plotW, 1)
    })
    const arrive = easeInOut(clamp(t * 1.6 - 0.6))
    if (arrive > 0) {
      ctx.globalAlpha = arrive
      ctx.fillStyle = ink
      ctx.fillText('the song', 0, h / 2)
    }
    ctx.globalAlpha = 1

    // the bars: each column sweeps over a little after the one to its left
    lanes.forEach((l, i) => {
      ctx.fillStyle = l.color
      const mid = laneMid(i)
      for (let c = 0; c < cols; c++) {
        const v = value(l.key, c)
        if (v < 0.012) continue
        let below = 0
        for (let j = 0; j < i; j++) below += value(lanes[j].key, c)
        const p = easeInOut(clamp(t * 1.35 - (c / cols) * 0.35))
        const laneBar = Math.min(laneH - 4, v * (laneH - 4))
        const laneTop = mid - laneBar / 2
        const stackTop = h / 2 - (totals[c] * k) / 2 + below * k
        const top = laneTop + (stackTop - laneTop) * p
        const bar = laneBar + (v * k - laneBar) * p
        ctx.fillRect(x0 + c * colW, top, barW, Math.max(1, bar))
      }
    })
  }

  function tick(now) {
    const dt = last ? now - last : 16
    last = now
    const dir = Math.sign(target - t)
    t = clamp(t + (dir * dt) / 1100)
    paint()
    if (t !== target) frame = requestAnimationFrame(tick)
    else frame = 0
  }

  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true'
    toggle.setAttribute('aria-pressed', String(on))
    read.textContent = on
      ? 'summed: within −144.9 dB of the song (a test song)'
      : '13 files, each sample in exactly one'
    target = on ? 1 : 0
    if (reduceMotion.matches) {
      t = target
      paint()
      return
    }
    if (!frame) {
      last = 0
      frame = requestAnimationFrame(tick)
    }
  })

  new ResizeObserver(() => paint()).observe(canvas)
  document.fonts?.ready.then(paint)
  paint()
}

/* ------------------------------------------------------------------ */
/* Trim studio: the editor's selection on a 16-bar demo song. The     */
/* names follow the app: rangeLabel, rangeLength (lib/grid.ts) and    */
/* mixLabel (state/mix.ts), with the default naming template.         */
/* ------------------------------------------------------------------ */

const GRID = { bpm: 128, downbeat: 0, beatsPerBar: 4 }
const BEAT_S = 60 / GRID.bpm
const BAR_S = BEAT_S * GRID.beatsPerBar
const TRIM_BARS = 16
const TRIM_DURATION = TRIM_BARS * BAR_S
const EPS_S = 0.0015
const TRIM_STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

const beatAtT = (t) => (t - GRID.downbeat) / BEAT_S
const isOn = (t, step) => { const n = beatAtT(t) / step; return Math.abs(n - Math.round(n)) * step * BEAT_S < EPS_S }
const barAtT = (t) => Math.floor(beatAtT(t) / GRID.beatsPerBar + 1e-9) + 1
function position(t) {
  const beats = beatAtT(t)
  const bar = Math.floor(beats / GRID.beatsPerBar + 1e-9) + 1
  const inBar = beats - (bar - 1) * GRID.beatsPerBar
  const beat = Math.floor(inBar + 1e-9) + 1
  const sixteenth = Math.floor((inBar - (beat - 1)) * 4 + 1e-6) + 1
  return sixteenth > 1 ? `${bar}.${beat}.${sixteenth}` : `${bar}.${beat}`
}
function fileTime(t) {
  const cs = Math.round(Math.max(0, t) * 100)
  return `${Math.floor(cs / 6000)}m${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}s`
}
function rangeLabel(r) {
  if (isOn(r.start, GRID.beatsPerBar) && isOn(r.end, GRID.beatsPerBar)) {
    const first = barAtT(r.start + EPS_S)
    const last = barAtT(r.end - EPS_S)
    return first === last ? `bar ${first}` : `bars ${first}-${last}`
  }
  if (isOn(r.start, 1) && isOn(r.end, 1)) return `${position(r.start)}-${position(r.end)}`
  return `${fileTime(r.start)}-${fileTime(r.end)}`
}
function rangeLength(r) {
  if (isOn(r.start, 1) && isOn(r.end, 1)) {
    const beats = Math.round((r.end - r.start) / BEAT_S)
    if (beats % GRID.beatsPerBar === 0) { const bars = beats / GRID.beatsPerBar; return `${bars} ${bars === 1 ? 'bar' : 'bars'}` }
    return `${beats} ${beats === 1 ? 'beat' : 'beats'}`
  }
  return `${(r.end - r.start).toFixed(2)} s`
}
function mixLabel(chosen, every) {
  const leftOut = every.filter((n) => !chosen.includes(n))
  if (chosen.length === 1 && leftOut.length > 0) return chosen[0]
  if (leftOut.length === 0) return 'mix'
  if (leftOut.length === 1) return `no ${leftOut[0]}`
  if (chosen.length <= 3) return chosen.join(' + ')
  if (leftOut.length <= 3) return `no ${leftOut.join(', ')}`
  return `${chosen.length} stems`
}

function setupTrim(stems) {
  const canvas = document.getElementById('trim-canvas')
  if (!canvas) return
  const stage = canvas.parentElement
  const selEl = document.getElementById('trim-sel')
  const ruler = document.getElementById('ruler')
  const chips = [...document.querySelectorAll('#trim-chips .chip')]
  const snaps = [...document.querySelectorAll('#trim-snap button')]
  const readout = document.getElementById('trim-readout')
  const file = document.getElementById('trim-file')
  const everyBtn = document.getElementById('trim-every')
  const files = document.getElementById('trim-files')
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  document.querySelectorAll('[data-mod]').forEach((el) => { el.textContent = isMac ? 'Cmd' : 'Ctrl' })

  // 16 bars: the 8-bar groove twice
  const song = Object.fromEntries([...TRIM_STEMS, 'mix'].map((n) => [n, [...stems[n], ...stems[n]]]))
  const cols = song.mix.length
  const css = getComputedStyle(document.documentElement)
  const color = (n) => (n === 'mix' ? css.getPropertyValue('--ink').trim() : css.getPropertyValue(`--${n}`).trim())

  let chosen = ['original']
  let snap = 'bar'
  let sel = { start: 4 * BAR_S, end: 8 * BAR_S }

  for (let bar = 1; bar <= TRIM_BARS; bar++) {
    const tick = document.createElement('span')
    tick.className = bar === 1 ? 'tick tick-one' : 'tick'
    tick.style.left = `${((bar - 1) / TRIM_BARS) * 100}%`
    tick.textContent = String(bar)
    ruler.append(tick)
  }

  function paint() {
    const w = stage.clientWidth
    const h = stage.clientHeight
    const dpr = Math.min(2, devicePixelRatio || 1)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // beat and bar lines
    for (let b = 0; b <= TRIM_BARS * 4; b++) {
      ctx.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)'
      ctx.fillRect(Math.round((b / (TRIM_BARS * 4)) * w), 0, 1, h)
    }
    const layers = chosen[0] === 'original' ? ['mix'] : chosen
    const colors = Object.fromEntries(layers.map((n) => [n, color(n)]))
    const step = w / cols
    const bw = Math.max(1, step * 0.62)
    const s0 = (sel ? sel.start / TRIM_DURATION : 0) * w
    const s1 = (sel ? sel.end / TRIM_DURATION : 0) * w
    for (let c = 0; c < cols; c++) {
      const x = c * step
      const inside = sel && x + bw > s0 && x < s1
      ctx.globalAlpha = inside || !sel ? 1 : 0.32
      // larger first, so a quieter stem is never hidden behind a louder one
      const order = [...layers].sort((a, b) => song[b][c] - song[a][c])
      for (const n of order) {
        const amp = Math.max(0.01, song[n][c]) * (h * 0.86)
        ctx.fillStyle = colors[n]
        ctx.fillRect(x, (h - amp) / 2, bw, amp)
      }
    }
    ctx.globalAlpha = 1
  }

  function show() {
    const target = chosen[0] === 'original' ? '' : mixLabel(chosen, TRIM_STEMS)
    chips.forEach((ch) => ch.setAttribute('aria-pressed', String(chosen.includes(ch.dataset.target))))
    snaps.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.snap === snap)))
    const tint = chosen[0] === 'original' ? 'var(--ink)' : `var(--${chosen[0]})`
    selEl.style.setProperty('--tint', tint)
    if (sel) {
      selEl.hidden = false
      selEl.style.left = `${(sel.start / TRIM_DURATION) * 100}%`
      selEl.style.width = `${((sel.end - sel.start) / TRIM_DURATION) * 100}%`
      const label = rangeLabel(sel)
      readout.innerHTML = `${label} <span class="muted">· ${rangeLength(sel)}</span>`
      file.textContent = `Demo song - ${target ? `${target} - ` : ''}${label}.wav`
      files.innerHTML = TRIM_STEMS.map((n) => `<li><i style="background:var(--${n})"></i>Demo song - ${n} - ${label}.wav</li>`).join('')
    } else {
      selEl.hidden = true
      readout.innerHTML = '<span class="muted">drag across the waveform to choose a part</span>'
      file.textContent = 'no part chosen'
      files.innerHTML = ''
    }
    paint()
  }

  // ---- choosing what to trim
  chips.forEach((ch) => ch.addEventListener('click', (e) => {
    const t = ch.dataset.target
    if (t === 'original' || !(e.ctrlKey || e.metaKey) || chosen[0] === 'original') chosen = [t]
    else if (chosen.includes(t)) { if (chosen.length > 1) chosen = chosen.filter((n) => n !== t) }
    else chosen = TRIM_STEMS.filter((n) => n === t || chosen.includes(n))
    show()
  }))
  snaps.forEach((b) => b.addEventListener('click', () => { snap = b.dataset.snap; show() }))
  everyBtn.addEventListener('click', () => {
    const open = everyBtn.getAttribute('aria-expanded') !== 'true'
    everyBtn.setAttribute('aria-expanded', String(open))
    files.hidden = !open
  })

  // ---- the selection: drag to make one, its edges to change it, its middle to move it
  const unit = (free) => (free || snap === 'off' ? 0 : snap === 'bar' ? BAR_S : BEAT_S)
  const snapT = (t, free) => { const u = unit(free); return u ? Math.round(t / u) * u : t }
  const timeAt = (clientX) => {
    const r = stage.getBoundingClientRect()
    return Math.min(TRIM_DURATION, Math.max(0, ((clientX - r.left) / r.width) * TRIM_DURATION))
  }
  let drag = null

  stage.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0) return
    const t = timeAt(e.clientX)
    const r = stage.getBoundingClientRect()
    const px = (s) => r.left + (s / TRIM_DURATION) * r.width
    let mode = 'new'
    if (sel && Math.abs(e.clientX - px(sel.start)) < 8) mode = 'start'
    else if (sel && Math.abs(e.clientX - px(sel.end)) < 8) mode = 'end'
    else if (sel && t > sel.start && t < sel.end) mode = 'move'
    drag = { mode, anchor: snapT(t, e.altKey), t0: t, orig: sel && { ...sel } }
    stage.setPointerCapture(e.pointerId)
    stage.classList.add('dragging')
    e.preventDefault()
  })
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect()
    if (!drag) {
      if (!sel) return stage.style.cursor = 'crosshair'
      const px = (s) => r.left + (s / TRIM_DURATION) * r.width
      const t = timeAt(e.clientX)
      stage.style.cursor = Math.abs(e.clientX - px(sel.start)) < 8 || Math.abs(e.clientX - px(sel.end)) < 8 ? 'ew-resize' : t > sel.start && t < sel.end ? 'grab' : 'crosshair'
      return
    }
    const t = timeAt(e.clientX)
    const free = e.altKey
    const min = unit(free) || 0.05
    if (drag.mode === 'new') {
      const b = snapT(t, free)
      const a = drag.anchor
      if (Math.abs(b - a) < min / 2) return
      sel = { start: Math.min(a, b), end: Math.max(a, b) }
    } else if (drag.mode === 'move') {
      const len = drag.orig.end - drag.orig.start
      let start = snapT(drag.orig.start + (t - drag.t0), free)
      start = Math.min(TRIM_DURATION - len, Math.max(0, start))
      sel = { start, end: start + len }
    } else if (drag.mode === 'start') {
      sel = { start: Math.min(snapT(t, free), drag.orig.end - min), end: drag.orig.end }
    } else {
      sel = { start: drag.orig.start, end: Math.max(snapT(t, free), drag.orig.start + min) }
    }
    show()
  })
  const end = () => { drag = null; stage.classList.remove('dragging') }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('dblclick', (e) => {
    const bar = Math.floor(timeAt(e.clientX) / BAR_S)
    sel = { start: bar * BAR_S, end: (bar + 1) * BAR_S }
    show()
  })
  document.getElementById('studio').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sel = null; show() }
  })

  let frame = 0
  addEventListener('resize', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint) })
  show()
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

const STEMS = build()
drawWaves(STEMS)
setupSupport()
setupRun()
setupChain()
setupShots()
setupSum(STEMS)
setupTrim(STEMS)
setupHow()
setupReveal()
loadChangelog()
loadRelease()
