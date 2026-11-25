# The website

OpenStems has a landing page at **https://lewisgoing.github.io/OpenStems/**. This page says
what is on it, which addresses are safe to link to, and what the app could link to. Why it is
built the way it is: `docs/adr/0025-site.md`. How to build and deploy it: the Site commands in
`CLAUDE.md`.

## What it is

One static page (`site/`: `index.html`, `style.css`, `main.js`, two fonts served with it). No
analytics, no cookies, and no request to anyone but GitHub. It deploys by itself when a change
to it, to `CHANGELOG.md` or to its three README pictures reaches `main`.

## Sections and their addresses

Each section has an anchor, so a link can open the page at that section. Treat these as
public addresses: renaming one breaks links already out in the world (and in installed apps).

| Section | Address | What it shows |
| --- | --- | --- |
| Top | `/OpenStems/` | The headline, a download button, and the app's windows one at a time (Queue, Studio, Tray) |
| How it works | `#how` | A song coming apart into six stems as the page scrolls |
| Every stem | `#every` | The four-model chain of `every-stem`, and a switch that sums its 13 stems back into the song |
| OpenStems Studio | `#trim` | A working demo of the trimmer: drag across a waveform, snap to bars, the clip's file name |
| What it does | `#features` | Six short feature notes, the drum-kit split, the recipes |
| Will it run? | `#run` | A picker: choose a machine and its memory, see which recipes fit |
| Download | `#download` | The newest release's Windows and Mac files, requirements, the Mac's first-open steps |
| Changelog | `#changelog` | The six newest releases from `CHANGELOG.md`, the latest one open |
| Support | `#support` | The Ko-fi button (https://ko-fi.com/lewisgoing), star on GitHub, report a bug |

The Studio section's anchor is still `#trim`, from before the section was renamed. Keep it.

## What on it is live, and what is copied

- **Live, no upkeep:** the version, release date and download sizes come from GitHub's
  release API in the visitor's browser. The changelog is read from `CHANGELOG.md`. Until
  GitHub answers (or if it never does) the version shown is the one in `app/package.json`
  when the site was last built, and the download buttons open the releases page.
- **Copied by hand, change both together:** the requirements, the Mac's first-open steps and
  the "Will it run?" table (`MACHINES` in `site/main.js`) follow the README. The Studio demo
  copies `rangeLabel`, `rangeLength` and `mixLabel` from the app.
- **Pictures:** `app.png`, `drums.png` and `quick-drop.png` come from `docs/images/` at build
  time, so retaking the README's pictures updates the site. `site/images/studio.png` is the
  site's own and is not retaken with them.

## Links from the app

The addresses live in `app/electron/links.ts` (`WEBSITE`, `REPOSITORY`, `siteLink(section)`),
which the main process and the renderer both read. A test (`app/src/test/links.test.tsx`)
checks that every section the app names is on the page, so an anchor renamed in `site/`
fails there.

| In the app | Opens | Why |
| --- | --- | --- |
| Settings > About, "Website" | `https://lewisgoing.github.io/OpenStems/` | The page explains the app better than the repository does |
| Settings > About, "What's new" | `…/OpenStems/#changelog` | The changelog, readable, without leaving for GitHub |
| Settings > About, "Support OpenStems" | `…/OpenStems/#support` | Says the app is free before asking, and offers a star for those who will not tip |
| Settings > About, "Source on GitHub" (beside the versions) | the repository | For the code and for reporting a bug |
| Settings > System, under "Memory for one model" | `…/OpenStems/#run` | Shows what fits on which machine |
| The Mac Help menu | the website, What's New, Support, then the repository | Help lands on the page for people; the code is the last item |

Windows has no menu bar in the window, so Settings > About is where both systems find the
links; the Mac Help menu repeats them.

`RELEASES_URL` (`app/electron/updatelogic.ts`) is left alone: an update offer must open the
release itself, where the files are, and the site's download buttons only point there too.

When adding one:

- In a window, use `ExternalLink` (`app/src/components/ui.tsx`): a real link with
  `target="_blank"`, which the main process sends to the browser when it starts with
  `https://` (`app/electron/windows.ts`). No new channel to the main process is needed.
- Add the section to `SITE_SECTIONS` in `links.ts` and build the address with `siteLink`.
- Windows and Mac get the link in the same change.
- The site says nothing the app depends on, so the app must still work with the page down.
