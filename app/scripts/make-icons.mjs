// Draws the app icon, the tray icons and the drag icons without any image library: a tiny
// rasterizer (rounded rectangles, 4x supersampling) plus a PNG, ICO and ICNS writer built on
// node:zlib. The files for a Mac (icon.icns, the *Template.png menu bar images) are made
// here too, so no Mac is needed to draw them.
//
//   node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(out, { recursive: true })

const STEMS = ['#f472b6', '#fbbf24', '#60a5fa', '#c8f04a']
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

function canvas(size, scale = 4) {
  const n = size * scale
  const data = new Float32Array(n * n * 4)
  const rect = (x, y, w, h, radius, hex, alpha = 1) => {
    const [r, g, b] = rgb(hex)
    const x0 = x * scale, y0 = y * scale, x1 = (x + w) * scale, y1 = (y + h) * scale, rad = radius * scale
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(n, Math.ceil(y1)); py++) {
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(n, Math.ceil(x1)); px++) {
        const cx = Math.min(Math.max(px + 0.5, x0 + rad), x1 - rad)
        const cy = Math.min(Math.max(py + 0.5, y0 + rad), y1 - rad)
        if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > rad) continue
        const i = (py * n + px) * 4
        const a = alpha + data[i + 3] * (1 - alpha)
        for (const [k, c] of [[0, r], [1, g], [2, b]]) {
          data[i + k] = (c * alpha + data[i + k] * data[i + 3] * (1 - alpha)) / (a || 1)
        }
        data[i + 3] = a
      }
    }
  }
  // Cut a hole: what is under a badge is removed, so the badge reads as a separate shape.
  const clear = (x, y, w, h, radius) => {
    const x0 = x * scale, y0 = y * scale, x1 = (x + w) * scale, y1 = (y + h) * scale, rad = radius * scale
    for (let py = Math.max(0, Math.floor(y0)); py < Math.min(n, Math.ceil(y1)); py++) {
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(n, Math.ceil(x1)); px++) {
        const cx = Math.min(Math.max(px + 0.5, x0 + rad), x1 - rad)
        const cy = Math.min(Math.max(py + 0.5, y0 + rad), y1 - rad)
        if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) <= rad) data[(py * n + px) * 4 + 3] = 0
      }
    }
  }
  const toPng = () => {
    const raw = Buffer.alloc(size * (size * 4 + 1))
    for (let y = 0; y < size; y++) {
      raw[y * (size * 4 + 1)] = 0
      for (let x = 0; x < size; x++) {
        const acc = [0, 0, 0, 0]
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const i = ((y * scale + sy) * n + x * scale + sx) * 4
            const a = data[i + 3]
            acc[0] += data[i] * a; acc[1] += data[i + 1] * a; acc[2] += data[i + 2] * a; acc[3] += a
          }
        }
        const o = y * (size * 4 + 1) + 1 + x * 4
        const a = acc[3] / (scale * scale)
        raw[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0
        raw[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0
        raw[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0
        raw[o + 3] = Math.round(a * 255)
      }
    }
    return png(size, size, raw)
  }
  return { rect, clear, toPng }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}
function png(width, height, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

/** App icon: a dark tile with four stem bars of different lengths. */
function appIcon(size) {
  const c = canvas(size)
  const u = size / 64
  c.rect(2 * u, 2 * u, 60 * u, 60 * u, 14 * u, '#16181d')
  c.rect(2 * u, 2 * u, 60 * u, 60 * u, 14 * u, '#ffffff', 0.03)
  const widths = [34, 22, 40, 28]
  widths.forEach((w, i) => c.rect(13 * u, (15 + i * 9.5) * u, w * u, 5.5 * u, 2.75 * u, STEMS[i]))
  return c.toPng()
}

/**
 * The same icon on the grid of a Mac: the tile is 824 of 1024 across with clear space around
 * it, as every Dock icon is, so it sits at the same size as its neighbours. The bars keep
 * their place inside the tile.
 */
function macAppIcon(size) {
  // The large sizes need less supersampling to look clean, and far less memory.
  const c = canvas(size, size >= 512 ? 2 : 4)
  const k = size / 1024
  const tile = 824
  const origin = (1024 - tile) / 2
  const radius = 185
  c.rect(origin * k, origin * k, tile * k, tile * k, radius * k, '#16181d')
  c.rect(origin * k, origin * k, tile * k, tile * k, radius * k, '#ffffff', 0.03)
  // The Windows tile is 60 units across, from 2: the same drawing, scaled into this tile.
  const u = (tile / 60) * k
  const at = (v) => origin * k + (v - 2) * u
  const widths = [34, 22, 40, 28]
  widths.forEach((w, i) => c.rect(at(13), at(15 + i * 9.5), w * u, 5.5 * u, 2.75 * u, STEMS[i]))
  return c.toPng()
}

/** An ICNS file: a header, then each PNG under the type code that names its size. */
function icns(images) {
  const entries = images.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4)
  return Buffer.concat([header, ...entries])
}

/** Drag icon: one stem "clip", or a small stack for several files. */
function dragIcon(count) {
  const size = 64
  const c = canvas(size)
  const layers = count > 1 ? 3 : 1
  for (let i = layers - 1; i >= 0; i--) {
    const offset = i * 5
    c.rect(6 + offset, 20 - offset, 46, 26, 6, '#16181d', i === 0 ? 0.96 : 0.7)
    c.rect(6 + offset, 20 - offset, 46, 26, 6, '#ffffff', 0.05)
  }
  const bars = [6, 13, 9, 17, 11, 15, 7, 12, 5]
  bars.forEach((h, i) => c.rect(11 + i * 4.2, 33 - h / 2, 2.4, h, 1.2, count > 1 ? STEMS[i % 4] : '#c8f04a'))
  return c.toPng()
}

/**
 * Tray icon: the stem bars from the title bar, with no tile behind them so they read on a
 * dark and on a light taskbar. While work is going on the fourth bar becomes a ring, and when
 * stems are waiting it becomes a filled dot: the states differ by shape, not only by color.
 * A new version keeps all four bars and lifts a small blue dot off the fourth, which is
 * cut short to make room: a badge, not a state of the work.
 */
function trayIcon(size, state) {
  const c = canvas(size)
  const u = size / 16
  const heights = state === 'update' ? [9, 14, 7, 6] : [9, 14, 7, 12]
  const barWidth = 2.6
  const gap = 1.1
  const idle = state === 'idle' || state === 'update'
  const left = idle ? (16 - (4 * barWidth + 3 * gap)) / 2 : 0.5
  heights.slice(0, idle ? 4 : 3).forEach((h, i) => {
    c.rect((left + i * (barWidth + gap)) * u, (15 - h) * u, barWidth * u, h * u, 1.3 * u, STEMS[i])
  })
  if (state === 'update') updateBadge(c, u, left + 3 * (barWidth + gap) + barWidth / 2, 4.4, '#60a5fa')
  if (!idle) {
    const d = 4.8
    const x = 15.8 - d
    const y = 15 - d
    c.rect(x * u, y * u, d * u, d * u, (d / 2) * u, state === 'ready' ? '#6ee7a0' : '#c8f04a')
    if (state === 'busy') c.clear((x + 1.5) * u, (y + 1.5) * u, (d - 3) * u, (d - 3) * u, (d / 2 - 1.5) * u)
  }
  return c.toPng()
}

/**
 * Menu bar icon for a Mac: a template image, black with alpha, which macOS colors for a
 * light or a dark menu bar. It cannot carry color, so the states read by shape alone: four
 * bars; three bars and a ring while work is going on; three bars and a solid dot when stems
 * are waiting. The ring and the dot are larger than on Windows, where color helps. A new
 * version: four bars, the fourth cut short under a small dot of its own.
 */
function menuBarIcon(size, state) {
  const c = canvas(size)
  const u = size / 16
  const heights = state === 'update' ? [9, 14, 7, 6] : [9, 14, 7, 12]
  const barWidth = 2.6
  const gap = 1.1
  const idle = state === 'idle' || state === 'update'
  const left = idle ? (16 - (4 * barWidth + 3 * gap)) / 2 : 0
  heights.slice(0, idle ? 4 : 3).forEach((h, i) => {
    c.rect((left + i * (barWidth + gap)) * u, (15 - h) * u, barWidth * u, h * u, 1.3 * u, '#000000')
  })
  if (state === 'update') updateBadge(c, u, left + 3 * (barWidth + gap) + barWidth / 2, 4.6, '#000000')
  if (!idle) {
    const d = 5
    const line = 1.25
    const x = 16 - d
    const y = 15 - d
    c.rect(x * u, y * u, d * u, d * u, (d / 2) * u, '#000000')
    if (state === 'busy') c.clear((x + line) * u, (y + line) * u, (d - 2 * line) * u, (d - 2 * line) * u, (d / 2 - line) * u)
  }
  return c.toPng()
}

/** The dot of a new version: centred over the fourth bar, near the top of the icon. */
function updateBadge(c, u, centre, d, color) {
  const x = Math.min(16 - d, centre - d / 2)
  c.rect(x * u, 0.6 * u, d * u, d * u, (d / 2) * u, color)
}

const TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
for (const state of ['idle', 'busy', 'ready', 'update']) {
  const name = state === 'idle' ? 'tray.ico' : `tray-${state}.ico`
  writeFileSync(join(out, name), ico(TRAY_SIZES.map((size) => ({ size, data: trayIcon(size, state) }))))
}
// The menu bar images for a Mac: 16 points, and the same drawing at twice the pixels. The
// names must end in `Template`, with `@2x` after it, or macOS treats them as plain pictures.
for (const state of ['idle', 'busy', 'ready', 'update']) {
  const name = state === 'idle' ? 'trayTemplate' : `tray-${state}Template`
  writeFileSync(join(out, `${name}.png`), menuBarIcon(16, state))
  writeFileSync(join(out, `${name}@2x.png`), menuBarIcon(32, state))
}
// For looking at the tray icons while drawing them: TRAY_PREVIEW=<folder> writes each size as a PNG.
if (process.env.TRAY_PREVIEW) {
  mkdirSync(process.env.TRAY_PREVIEW, { recursive: true })
  for (const state of ['idle', 'busy', 'ready', 'update']) {
    for (const size of [16, 24, 32, 64]) writeFileSync(join(process.env.TRAY_PREVIEW, `${state}-${size}.png`), trayIcon(size, state))
    for (const size of [16, 32, 128]) writeFileSync(join(process.env.TRAY_PREVIEW, `mac-${state}-${size}.png`), menuBarIcon(size, state))
  }
  writeFileSync(join(process.env.TRAY_PREVIEW, 'mac-app-512.png'), macAppIcon(512))
}

writeFileSync(join(out, 'icon.png'), appIcon(256))
writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 256].map((size) => ({ size, data: appIcon(size) }))))
// The Mac app icon. Each type code is one size in pixels; the second row is the `@2x` set.
const ICNS_TYPES = [
  ['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
]
const macIcons = new Map()
for (const [, size] of ICNS_TYPES) if (!macIcons.has(size)) macIcons.set(size, macAppIcon(size))
writeFileSync(join(out, 'icon.icns'), icns(ICNS_TYPES.map(([type, size]) => ({ type, data: macIcons.get(size) }))))
writeFileSync(join(out, 'drag-one.png'), dragIcon(1))
writeFileSync(join(out, 'drag-many.png'), dragIcon(3))
console.log(`icons written to ${out}`)
