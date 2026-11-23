# 0017: The every-stem recipe and stem groups

Date: 2026-11-23. Status: accepted.

Not in `PLAN.md`: a tenth recipe, and one new idea in a recipe, the group.

## Decision

`every-stem` is the deepest split the installed models can make reliably, as one recipe.
Four models from the seed set run in a chain:

| Pass | Model | Input | Gives |
| --- | --- | --- | --- |
| `vox` | Leap Xe vocals | the mix | vocals |
| `split` | becruily karaoke | `vox.vocals` | lead vocals; backing = vocals minus lead |
| `sw` | BS-RoFormer SW | the mix | drums, bass, guitar, piano, other |
| `kit` | DrumSep | `sw.drums` | kick, snare, toms, hh, ride, crash; other drums = drums minus those six |

Thirteen files: lead vocals, backing vocals; kick, snare, toms, hh, ride, crash, other
drums; bass; guitar, piano, other.

It needed no new machinery to run: a recipe was already a chain of passes with derived
stems. It is `full-song-best-vocals` with two of its stems split further, so SW runs on the
mix, as ADR 0003 settled.

## Each sample in exactly one file

The larger stems (vocals, drums) are not written. Their parts add up to them, to float32
rounding, so writing both would put the drums into a DAW twice when every stem is dragged
in, and the stems would no longer sum to the song. With "Sum to mix" on, the thirteen files
are the song: the residual on a test song was -144.9 dB.

That is why two of the stems are differences:

- **backing vocals** is the vocals minus the lead, as in `acapella-clean`.
- **other drums** is the drums minus DrumSep's six pieces. DrumSep does not account for all
  of its input: on two test songs what it left was 21.6 and 25.8 dB below the drums (room,
  bleed, hand percussion). Without a stem of its own that part would be lost, or with "Sum
  to mix" it would land in the melodic `other`.

## Groups

An output of a recipe can name a `group`: the larger stem it is a part of.

```toml
[[outputs]]
stem = "kick"
from = "kit.kick"
group = "drums"
```

`every-stem` has three: vocals (2 parts), drums (7) and melody (guitar, piano, other; the
same meaning of melody as the `melody` recipe). Bass is in none.

- A group is a label on files, never a file. The whole of a group is a mix of its parts,
  which `POST /v1/mixes` already writes.
- A mix that is exactly one group is named after it: the kit together is
  `<track> - drums.wav`, everything but the kit is `no drums` (`mix_label` and `mixLabel`,
  changed together).
- A group cannot have the name of an output stem of the same recipe, so those names stay
  unambiguous.
- The group is in the recipe (`output_groups` in the API), in the manifest and on each stem
  of a job (`group`). It is written only where there is one, so the cache key of every
  other recipe is unchanged and earlier results stay valid.
- User recipes can use `group` too.

In the app the stems panel puts a heading over each group. Solo and mute on the heading act
on every part. The heading's handle drags the group out as one file; the engine writes it
when the pointer first reaches the handle, since a drag needs the file to exist, and nothing
is written for a group nobody reaches for. Under a heading a part goes by its short name
("lead", not "lead vocals"). A recipe without groups looks as it did. The recipe bar shows a
grouped recipe as its groups with their number of parts. Nothing new animates: headings are
there from the first paint, and solo and mute change at once, as ADR 0005 has it.

## The melody is not split further

The request was to split the melody "as much as possible". The only model that could go
past guitar, piano and other is the 53-stem model, run on those stems. It was measured on
2026-11-23 (Balanced, two test songs) and does not work as a splitter:

- On the SW guitar stem, its `guitar`, `electric-guitar` and `strings` outputs each returned
  the whole input (0.0 dB relative to it). On an `other` stem that was an organ, `keys`,
  `organ` and `accordion` each returned nearly all of it (-0.3, -1.1 and -1.4 dB).
- So its stems overlap and it mislabels: it answers "is there some of this instrument" for
  each stem on its own. No fixed set of its stems partitions an input. What three plausible
  sets left of that `other` stem ranged from -15 to -25 dB, depending on which family
  happened to hold the instrument, and a subtracted remainder would carry the double counts
  with the sign turned.
- On a nearly silent input (the piano stem of a song without piano) it returned noise in a
  dozen stems.

It stays what it is: `mega-53`, where the user ticks the instruments they know are there.
It also needs 9.5 GB and is not in the seed set. If a model appears that splits `other`
into parts that add up, it goes into this recipe as one more pass and a larger melody group.

## Cost and fit

Four model runs instead of the two of `full-song-best-vocals`: 48 s against 36 s for a
56-second song at Balanced on the RTX 5070 Ti, model loading included.

Models run one at a time, so the recipe is as large as its largest model, Leap Xe: it fits
wherever `full-song-best-vocals` fits (`docs/adr/0015-low-memory.md`), with the same caveat
that the Mac and full-precision figures are estimates. Nothing in it differs between
Windows and a Mac; it has not been run on a Mac by us.

## Checked

- Engine tests with the FakeEngine: the thirteen stems and their groups, the parts adding up
  to the stems of `full-song-best-vocals`, the sum to the mix, the unchanged cache key, the
  mix names (`tests/test_recipes_catalog.py`, `tests/test_links_mixes.py`).
- On the GPU: `openstems separate "Funk Game Loop.mp3" --recipe every-stem --sum-to-mix -q
  balanced -f wav32f`, then `check_stems.py --sum-to-mix`: thirteen aligned stems, residual
  -144.9 dB.
- App: component tests for the headings, group solo, mute and drag
  (`src/test/components.test.tsx`, `logic.test.ts`) and `e2e/every-stem.spec.ts` with the
  FakeEngine.

Not checked: the test songs are instrumentals, so the lead and backing split was not heard
on a real voice in this recipe (the same two models chain this way in `acapella-clean`,
there with de-reverb between them). Nothing was judged by ear.
