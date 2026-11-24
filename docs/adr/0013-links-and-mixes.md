# 0013: Songs from links, and mixes of stems

Date: 2026-11-22. Status: accepted.

Two additions to getting a song in and getting sound out. Neither is in `PLAN.md`.

## Songs from links

### Decision

A web address can be queued like a file: paste it (Ctrl+V, or the Paste link button in
either window) or drag it in from a browser. The engine fetches the audio behind it and then
queues it as an ordinary job, with the recipe, quality and options that were selected when
the link was pasted.

[yt-dlp](https://github.com/yt-dlp/yt-dlp) does the fetching, as a Python dependency of the
engine, pinned to `2026.11.23` (first `2026.10.26`) with its `default` and `deno` extras. Those bring
`yt-dlp-ejs` and the Deno runtime (`deno` 2.9.8 from PyPI): since late 2025 yt-dlp needs an
external JavaScript runtime for YouTube. The engine passes Deno's path to yt-dlp itself,
because the environment's `Scripts` folder is not on `PATH` when the app starts the engine.

Nothing is bundled into the installer for this. The packages are in the pinned requirements
of all three builds, so first-run setup installs them, and an app that updates gets them
through the quick environment refresh (ADR 0010): six packages, about 45 MB, a few seconds.

### How it works

- **A link is not a job.** The queue is about files. A link has its own short life in
  `api/links.py` (`waiting`, `resolving`, `downloading`), on a thread of its own, with
  progress on the event bus as `link.updated`. When the file is on disk the service queues a
  job for it and the link is gone (`link.removed`). At most two fetches run at once.
- **Both windows show a link as a row** where its job will appear, with the progress of the
  fetch. To the person waiting it is a job that is working.
- **A fetch that failed stays**, with the reason in a sentence, until it is tried again or
  dismissed. yt-dlp's messages are cleaned of their prefixes; the common cases (a page with
  no song, no connection, a missing page) have wording of their own.
- **Only the audio is fetched**, in the format the site stores it in (`bestaudio/best`).
  Nothing is converted, so FFmpeg is not needed: the decoder (PyAV) reads Opus in WebM and
  AAC in M4A as they are.
- **Where it goes:** `<output folder>/_links/<12 hex digits>/<title>.<ext>`. The output folder
  is the drive the user chose for large files, and the watch folder never looks into it. One
  folder per address means two songs with the same title never share a file, and the same
  link pasted again finds its file already there. The file's name is the song's title, so the
  track and its stems are named after the song.
- **Manual start applies.** A fetched song waits for Start when dropped songs do.
- **Refused, with a reason:** playlists (which song was meant?), live streams, and anything
  over three hours. A song's address that also names a playlist is taken as the song.
- **Only `http` and `https`** addresses are accepted.

### What is fragile

Sites change, and a pinned yt-dlp falls behind them. When YouTube changes something, fetches
fail until OpenStems ships a newer pin. The self-update exists for this: bump
`yt-dlp[default,deno]` in `engine/pyproject.toml`, `uv lock`, release. The quick refresh
installs the new version on the user's machine without rebuilding anything.

Added after 0.3.1: nothing told us when that moment had come. A scheduled workflow,
`.github/workflows/links-check.yml`, now compares the pin with the newest yt-dlp on PyPI
every day (`scripts/check_ytdlp.py`) and keeps one issue open while the pin is behind, so the
owner gets an e-mail; it closes the issue once the pin is current. A new yt-dlp release is
taken as the sign that a site changed. The workflow does not fetch a real song: sites turn
away the addresses GitHub's runners use, so a failure there would say nothing about the app
on a user's machine. Two limits: not every yt-dlp release fixes something OpenStems users
would notice, and a site can break before yt-dlp has a fix out. `check_ytdlp.py --write`
moves the pin; `uv lock` and a release follow by hand, because a new pin should be tried
with a real link first. Installed apps are still updated only through a release.

Sites also sign the addresses of their media for a short time, and now and then turn a
download away (`HTTP Error 403`). That happened once in five real runs here. The fetcher asks
the site again, up to three times in all, before it reports a failure (`links.retrying`).
Every other failure is final at once.

The fetched files are kept: they are the source of their stems, and History reruns from them.
Nothing removes them yet. They are small (a few megabytes a song).

What people fetch is their responsibility: the README says to fetch only what one has the
right to use.

### Checked

- A real YouTube link and a real SoundCloud link, fetched through `openstems.links.fetch`
  with an empty `PATH` (Deno found by its own path): 8 and 4 seconds.
- The same from an installed app's environment after the update step the app runs
  (`uv pip install --no-deps --requirement ...`): six packages added in 1.6 seconds.
- A real link through the real engine: fetched, separated on the GPU (27 seconds in all for
  a 2:22 song at Fast) and mixed.
- A playlist, a missing video, a page with no song and no connection each fail with a
  sentence.
- A real link pasted into the app itself, with the real engine: fetched, separated on the
  GPU, the vocals muted and the mix dragged out (`REAL_LINK=<address> REAL_MODELS=<folder>
  pnpm e2e -g "pasted link is fetched from the web"`, 41 seconds).
- Engine tests use a stand-in for the fetch (`OPENSTEMS_ENGINE=fake`): no test touches the
  network. `slow`, `fail` and `playlist` in the address make it slow, fail or refuse.

## Mixes of stems

### Decision

Some of a song's stems can leave as one file: everything but the vocals, the drums and bass
together. `POST /v1/mixes` takes the stem files, sums them as they are on disk, and writes
the result into a `Mixes` folder beside them, in the stems' own format, named by the stems'
own naming template with the mix in place of the stem (`Song - no vocals.wav`).

### How it works

- **The engine writes the file, ahead of the drag.** A native drag needs a real file before
  it starts, and a DAW that references the file in place needs it to stay. So the app asks
  for the file as soon as the choice of stems has settled (350 ms), and the drag handle says
  "Preparing" until it is there. A six-stem mix of a 2:22 song takes 0.3 seconds.
- **In the quick-drop window**, Mix turns the stem pills into the mix: every stem starts in,
  a click leaves one out or puts it back, and a line under them plays what is in, names it,
  and holds the drag handle. Dragging a pill is still that stem alone. Outside mixing, a
  click still plays one stem, as before.
- **In the full window**, what solo and mute leave audible is the mix: a "Drag mix" handle
  appears beside "Drag all" while not every stem is audible.
- **Playback of a mix** is the existing synced player: every stem decoded, all started at one
  time, in and out by gain, so leaving a stem out is heard at once. The stems are loaded when
  Play is pressed, not when mixing is turned on, and let go when it is turned off.
- **One stem is not a mix:** the handle then drags the stem's own file. Every stem is the
  song: there is nothing to write, and the line says how to leave one out.
- **Trimmed stems are put back in place** by their offsets from the manifest. Stems are
  summed as written, so with "normalize" on, the mix is of normalized stems.
- The name is decided in two places that must agree: `mix_label` in `pipeline/mix.py` names
  the file, `mixLabel` in `app/src/state/mix.ts` names it on screen. Both have the same test.
  Parts of one group with up to three of its parts left out go by the group, `drums no
  kick` (ADR 0017), where a count ("6 stems") would say nothing of what is in the file.

### Not done

- No level per stem: a stem is in or out.
- A mix is not listed in the manifest or in History. It is a file beside the stems; running
  the song again leaves earlier mixes where they are, and asking for the same mix writes it
  anew from the new stems.
