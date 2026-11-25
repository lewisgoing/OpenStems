// Assembles the GitHub Pages site: `site/` plus the files it shares with the repository
// (the changelog, the app icon, three README pictures), so nothing is kept twice.
// Usage: node scripts/build-site.mjs [out folder, default _site]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(root, '_site'))

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'images'), { recursive: true })
cpSync(join(root, 'site'), out, { recursive: true })
cpSync(join(root, 'CHANGELOG.md'), join(out, 'CHANGELOG.md'))
cpSync(join(root, 'app', 'resources', 'icon.png'), join(out, 'icon.png'))
for (const name of ['app.png', 'drums.png', 'quick-drop.png']) {
  cpSync(join(root, 'docs', 'images', name), join(out, 'images', name))
}
// The version shown before GitHub answers (and if it never does) is the app's own, not one typed into the page.
const { version } = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8'))
// a stamp on the stylesheet and script, so a browser never keeps last build's copy
const stamp = Date.now().toString(36)
const page = join(out, 'index.html')
writeFileSync(
  page,
  readFileSync(page, 'utf8')
    .replace('href="style.css"', `href="style.css?v=${stamp}"`)
    .replace('src="main.js"', `src="main.js?v=${stamp}"`)
    .replace(/(data-fill="(?:version|released)">)[^<]*</g, `$1${version}<`),
)
console.log(`site written to ${out}`)
