# Stem to MIDI at Melodyne level: research and plan

2026-11-23. The plan behind Phase 7 in `PLAN.md`; nothing here is built yet. The owner's
decisions of 2026-11-23 are in section 10. Numbers marked *reported* were read from a paper or page by a research pass and were
not re-checked against the original table; check them before quoting them elsewhere.

## Summary

- **The goal is to beat Melodyne, not to copy it** (the owner's direction, 2026-11-23).
  - **What Melodyne does:** DNA finds notes in a single instrument's audio, grades each one
    with a probability, and relies on the user to correct it. Its MIDI export is plain notes
    with velocity taken from amplitude, and no pitch bend.
  - **What the app matches:** that note quality, a confidence on every note, and a way to
    correct them.
  - **Where it goes further,** on points where Melodyne is silent or weak:
    - drums on their own General MIDI notes; Melodyne exports percussive material all on one
      pitch;
    - each note's pitch curve as bends or MPE, and the piano's sustain pedal;
    - fewer of Melodyne's known errors: octave slips, overtone ghosts, missed high notes, loose
      timing on soft attacks;
    - whole-song context: bleed between stems, the song's tuning and key.

  No single model is "universal", so none of this comes from one model.
- **The app is already in a better position than a generic transcriber.** It produces clean,
  labelled stems: lead and backing vocals, bass, guitar, piano, other, a drum kit split into
  kick, snare, toms, hi-hat, ride and crash, and 53 instrument stems in `mega-53`. Each stem can
  go to the method that suits it, rather than one model guessing at a mix.
- **The order that gives the most quality for the least work:**
  1. Drums, from the drum parts the app already separates. Plain onset detection handles kick
     and snare. A small model trained on CC BY drum data covers toms, hi-hats and cymbals.
     Today drums get no MIDI at all.
  2. Monophonic stems: vocals, bass and lead lines, with a neural pitch tracker, note
     segmentation and per-note pitch curves.
  3. Polyphonic stems: a piano model for piano and an instrument-agnostic model for the rest.
     A refinement layer removes overtone ghosts and bleed.
  4. A note editor with a confidence slider.
  5. Last, training on the app's own separator output.
- **Licenses are the hardest constraint, harder than accuracy.** Several of the strongest
  models are non-commercial outright: the ADTOF drum model, the SOME vocal-note model,
  MuScriptor, Guitab, and FCPE's published weights.
  - The permissively licensed ones are nearly all trained partly on restricted data:
    - every strong piano model on MAESTRO (CC BY-NC-SA 4.0), Basic Pitch included;
    - nearly every pitch tracker on MIR-1K or MDB.
  - Only two cleanly trained models were found:
    - MR-MT3, trained on Slakh alone, which is weak;
    - pYIN, which is plain signal processing.
  - The plan sorts models into three tiers (section 4) and asks the owner one question: are
    permissively licensed weights trained partly on restricted data acceptable? Every stage
    has a fallback that is clean throughout, and later stages train clean replacements on CC
    BY data.
- **Stage M0 is measurement.** Before any model is chosen, build a benchmark that runs CC BY
  multitracks (Slakh2100, GuitarSet, E-GMD) through the app's own separators and scores the
  transcription of the separated stems. Nobody has published that measurement. The evidence
  that stems help is mixed: one informal test found a multi-instrument model run on every stem
  re-transcribes the bleed in each one.

## 1. What "Melodyne-level" means

What Melodyne does, from Celemony's patent and manuals:

| Aspect | What Melodyne does | Source |
| --- | --- | --- |
| Detection | Polyphonic detection (DNA) is built for one instrument or a family of similar ones, not full mixes | [Sound On Sound review, 2009](https://www.soundonsound.com/reviews/celemony-melodyne-dna-editor) |
| Method | Phase-derived instantaneous frequency on a cent grid, then harmonic-sum salience. The strongest note is found, part of its energy subtracted, and the search repeated. Onsets are found separately as "event objects" and attached to notes, and an energy rise inside a note splits it | [US 8,022,286](https://patents.google.com/patent/US8022286) |
| Overtones | Shared harmonics are divided among notes by normalized per-bin weights, not given to one note, so each note gets its own audio | same patent |
| Per-note data | A pitch center, a slow "drift" curve and a fast "modulation" (vibrato) curve, each scalable from 100% to 0% and inverted at -100% | [Celemony: modulation and drift](https://helpcenter.celemony.com/M5/doc/melodyneStudio5/en/M5tour_ToolModulationDrift_2) |
| Confidence | Every detected note has a probability grade. A slider sets how many candidates are shown and used, and "hollow" potential notes can be switched on | Sound On Sound; [Note Assignment mode](https://helpcenter.celemony.com/M5/doc/melodyneEditor5/en/M5tour_NA_Mode_1) |
| Correction | Expected. The reviewer never saw a polyphonic first pass with every note right | Sound On Sound |
| MIDI export | One plain note per audio note, with velocity from amplitude. No pitch bend is documented. Breaths are not exported, and Universal/percussive material is exported all on one pitch | [Celemony: Audio to MIDI](https://helpcenter.celemony.com/M5/doc/melodyneAssistant5/en/M5tour_ExportMIDI_otherDAWs) |
| Known weaknesses | Octave errors, extra notes, missed notes in high registers, smeared transients on piano, harp and acoustic guitar, weak on driven guitar, and loose MIDI timing on soft attacks | Sound On Sound; [Arranger For Hire comparison](https://arrangerforhire.com/we-compared-automatic-audio-to-midi-transcription-tools-to-aural-transcription-by-a-music-arranger/) |

The target is better than Melodyne, measured in stage M0. Melodyne is the baseline to beat, not
a design to copy.

- **Notes.**
  - For each stem class, note F1 (onset, and onset plus offset) is at or above Melodyne's own
    MIDI export of the same stem.
  - The baseline is Melodyne itself if the owner can run an editor or studio licence, or the
    trial. Otherwise published figures stand in.
- **Past Melodyne, each with a number:**
  - drum onset F1 per kit part;
  - pitch-curve error in cents;
  - octave errors and overtone ghosts per minute;
  - median onset error in milliseconds on soft attacks;
  - how well the confidence scores are calibrated.
- **Workflow.** Low-confidence notes are shown, not silently dropped. Correcting and
  re-exporting needs no re-analysis.
- **Method.** The app does not reuse Melodyne's method. Its output is MIDI, so it never needs
  per-note audio. It therefore neither divides the spectrum among notes nor peels notes off one
  at a time.

## 2. Where the field is (late 2026)

All figures are *reported*. "Onset F1" means mir_eval note F1: onset within 50 ms and pitch
within 50 cents. "+Offset" also requires the offset within 20% of the note or 50 ms.

| Class | Best published result found | Notes |
| --- | --- | --- |
| Piano (clean) | Transkun V2 on MAESTRO v3: onset 0.983, +offset 0.935, +velocity 0.930 ([repo](https://github.com/Yujia-Yan/Transkun)) | Out of domain on MAPS it falls to 0.885 and 0.646; with augmentation 0.922 and 0.698. Trained on MAESTRO |
| Multi-instrument | YourMT3+ (45.8M params): Slakh onset about 84.6; MAESTRO 97.0; GuitarSet 91.7; URMP 81.8; ENST drums 89.5 ([arXiv 2407.04822](https://arxiv.org/abs/2407.04822); figures read by an extraction model) | On real pop (RWC), instruments other than piano, bass, vocals and drums score under 10%. Octave errors on non-piano instruments |
| Multi-instrument, unseen | 2025 AMT Challenge, instrument-aware onset F1: MIROS 0.600, YourMT3+ 0.594, MT3 0.393, Basic Pitch 0.063 ([arXiv 2603.27528](https://arxiv.org/abs/2603.27528)) | F1 falls with polyphony: MIROS 0.72 (one instrument), 0.50 (two), 0.44 (three). The metric needs the instrument label, which penalizes instrument-agnostic models. The abstract says two entries beat MT3, the table shows four |
| Instrument-agnostic | Basic Pitch (16,782 params): onset-only F1 0.71 MAESTRO, 0.42 Slakh, 0.52 Molina vocals, 0.79 to 0.84 GuitarSet; +offset only 0.11 on MAESTRO ([paper](https://arxiv.org/pdf/2203.09893)) | Best on solo guitar at the time. Far behind specialists on piano and vocals. Note creation is heuristic |
| Vocals | Mel-RoFormer (separation-pretrained, 64.6M): MIR-ST500 COn 0.819, COnP 0.798, COnPOff 0.625 ([arXiv 2409.04702](https://arxiv.org/abs/2409.04702)) | Weights not released. Offsets are the weak point everywhere |
| Drums | ADTOF: MDBDrums++ F 88.7 (PyTorch port 88.5) ([repo](https://github.com/MZehren/ADTOF)) | 5 classes. Code and weights CC BY-NC-SA 4.0 |
| Drums via part separation | Demucs drums, then ADTOF, then a sub-stem separator for velocity and 7 to 8 classes: onset F1 0.89 MDB, 0.85 ENST ([arXiv 2509.24853](https://arxiv.org/abs/2509.24853)) | Separation neither clearly helped nor hurt onsets; its value is velocity and finer classes |
| Monophonic pitch | FCPE (10.6M): MIR-1K raw pitch accuracy 96.8%, 5.3x faster than RMVPE; RMVPE keeps 43.6% at -20 dB SNR, where CREPE collapses to 1.1% ([arXiv 2509.15140](https://arxiv.org/html/2509.15140v1)) | All tested on voice. No instrument or separated-stem results |
| Commercial | Vendor-run benchmark on full mixes (Songscription's own): piano 89.4 (Songscription) and 88.9 (Klangio); multi-instrument 40 to 52 for all tools ([blog](https://www.songscription.ai/blog/best-audio-to-midi-converters)) | Run by a vendor that ranks itself first. Dataset not named. Indicative only |

What the evidence says about the methods:

- **Specialists beat generalists by a wide margin on their own instrument.** Basic Pitch scores
  0.71 on piano against 0.95 for Onsets and Frames. This supports routing by stem.
- **Synthetic training data generalizes poorly to real recordings.** YourMT3+ falls under 10%
  on non-main instruments of real pop. The challenge organizers name data, not architecture, as
  the binding limit.
- **Every stage that adds a note tracker or an acoustic check helps a little; none replaces
  labels.**
  - A calibrated HMM per pitch adds 5 to 8 points of frame F over a fixed threshold on MAPS. An
    uncalibrated one adds almost nothing ([arXiv 1704.08729](https://arxiv.org/pdf/1704.08729)).
  - A resynthesis loss added to supervised training raised MAPS F from 76.3 to 78.2. Resynthesis
    alone reached 54.3, against 37.7 for NMF ([paper](https://boblsturm.github.io/aimusic2020/papers/CSMC__MuMe_2020_paper_31.pdf)).
  - Gradient descent on oscillator frequency is non-convex. It refines a pitch that is already
    close, but cannot find one or fix an octave error ([arXiv 2210.14476](https://arxiv.org/pdf/2210.14476v2)).
- **Two failure modes dominate commercial and open tools alike:** overtones turned into ghost
  notes, and wrong note lengths (Arranger For Hire; Futureproof roundup, secondary).

## 3. Does transcribing a separated stem help?

The direct question has no peer-reviewed answer for pitched instruments. What exists points
both ways:

- **For:** accuracy collapses as the number of instruments rises: MIROS 0.72, 0.50, 0.44 for one
  to three instruments, and precision 0.91 to 0.46. Celemony itself limits DNA to single
  instruments. YourMT3 without stem augmentation scored 3.6% on singing straight from the mix,
  against 68 to 72% on Spleeter-separated vocals.
- **Against:**
  - A model trained for mixtures gains little from separation: YourMT3+ with augmentation
    scored 64 to 71% on the mix, within about a point of separated input.
  - For lyrics, zero-shot Whisper did *worse* on HTDemucs vocals than on the mix (WER 39.1
    against 35.4), though better on a stronger separator ([arXiv 2506.02339](https://arxiv.org/abs/2506.02339)).
  - In speech, processing artifacts, more than leftover interference, are what hurt
    recognizers ([arXiv 2201.06685](https://arxiv.org/abs/2201.06685)).
- **A trap:** an informal, non-peer-reviewed test ran a multi-instrument model naively on all
  six Demucs stems. Notes rose from 386 to 2,820 and onset F1 fell from 83.4 to 22.5, because
  bleed was transcribed again in every stem. MR-MT3 fell from 65.2 to 47.8 the same way.
  Source: [PR 195 on JDeun/audio-score-tool](https://github.com/JDeun/audio-score-tool/pull/195),
  checked; it ran on four synthetic examples from a training split, on the CPU.
- **What fixes the mismatch:**
  - Fine-tuning on the separator's own output gave the largest gain in the lyrics study (WER
    33.5 to 29.7), and it also improved mixture input.
  - Augmentation lifted Transkun out of domain.
  - Stem augmentation added over 4 points to YourMT3+.
- **Joint separation and transcription is a small win for transcription.** Jointist moved
  instrument-wise F1 from 23.2 to 24.7, and only with a pretrained transcriber. The bigger
  effect runs the other way: notes help separation. Separation SDR rose from 1.52 to 2.01 dB
  with predicted rolls and to 4.06 dB with true rolls ([arXiv 2302.00286](https://arxiv.org/abs/2302.00286)).
- **A separation network makes a good transcription encoder.** Mel-RoFormer fine-tuned from
  vocal separation reached vocal-transcription state of the art in under 15K steps. Training
  from scratch was "significantly inferior".

What this means for the design:

- Each stem goes to a model or method that expects one instrument.
- Bleed is handled across stems, not per stem. The app knows every stem of a track, and in its
  recipes the stems add up to the mix.
- Stage M0 measures clean stems, separated stems and the mix side by side.
- Stage M6 fine-tunes on separator output.

## 4. What can ship

Checked 2026-11-23 from LICENSE files, model cards and PyPI. Nearly every useful pitch or
transcription model is trained partly on data with research-only or non-commercial terms
(MIR-1K, MDB-stem-synth, MedleyDB, MAESTRO), even when its weights carry an MIT or Apache
license. Candidates therefore fall into three tiers:

- **A: clean weights and clean training data.** Ships by default. Few exist today; models the
  app trains itself on CC BY data would join this tier.
- **B: permissive weights, but training data that includes restricted sets.** Whether such
  weights are bound by the data's terms is unsettled. This is an owner decision (section 10).
- **C: non-commercial, ShareAlike or no license on the weights.** Never a default.

### Pitch trackers (vocals, bass, lead lines)

| Model | Code | Weights | Trained on | Runs on | Range | Reported | Tier and use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SwiftF0 0.3.0 (2026-09) | MIT | MIT, about 96K params, inside the wheel | NSynth, PTDB-TUG, MIR-1K, MDB-stem-synth, synthetic speech | ONNX Runtime on the CPU, no torch; declares Python 3.8 to 3.14 | 46.9 to 2,094 Hz | Voice and instruments at 10 dB SNR: raw pitch accuracy 89.9 (CREPE 79.0); about 42x faster than CREPE on the CPU | B. **Default for vocals and leads.** Its floor misses bass notes below about G1 |
| torchcrepe 0.0.24 | MIT | MIT repo, inside the wheel (72 MB) | MIR-1K, Bach10, RWC-synth, MedleyDB, MDB-stem-synth, NSynth | PyTorch | CREPE's bins are believed to start at C1 (32.7 Hz); confirm | MIR-1K raw pitch 97.9 (secondary) | B. **Candidate for bass**, after a test |
| librosa.pyin | ISC | none | — | numpy | any `fmin` | — | A. DSP fallback, for bass below SwiftF0's floor |
| FCPE (torchfcpe 0.0.4) | MIT | The wheel's `fcpe_c_v001.pt` is MIT, training data not stated. The Hugging Face `DDSP_200k.pt` is CC BY-NC-SA 4.0 | Paper: resynthesized M4Singer (NC-SA) and VCTK | PyTorch (uses `torch.stft`) | C1 to about B6 | The paper's model has raw pitch 96.8 on MIR-1K. The wheel's model is unmeasured | B for the wheel's model, after measurement. C for the Hugging Face one |
| RMVPE | Apache-2.0 (no weights in that repository) | The common `rmvpe.pt` has an MIT card, but its repository's license adds a research-only notice | Not stated for that file | PyTorch | — | MIR-1K raw pitch 95.4 | Unclear. Not a default until the license is settled |
| PESTO 2.0.1 | LGPL-3.0 | Inside the LGPL package; MIR-1K only, so voice only | MIR-1K | PyTorch | — | MIR-1K raw pitch 96.1 | Not used (LGPL, voice only) |

### Note segmentation and vocal note models

- **No vocal note model with clean weights was found:**
  - SOME and GAME (openvpi): weights CC BY-NC-SA 4.0.
  - ROSVOT: weights unlicensed, trained on M4Singer (NC-SA).
  - VOCANO: no license on its weights.
- **Note-segmentation code is also off-limits:**
  - The note HMM of Tony/pYIN is GPL, and pypYIN is AGPL-3.0.
  - The app writes its own segmenter from the published method (Mauch et al., 2015, "Tony"),
    on top of a clean pitch tracker. An algorithm described in a paper is free to reimplement;
    the GPL code is not copied.

### Drums

| Model | License | Notes | Reported |
| --- | --- | --- | --- |
| Magenta Onsets and Frames Drums | Apache-2.0 code, archived 2026-01. Checkpoint license not stated | Trained on E-GMD only (clean). TensorFlow 1, no PyTorch port | E-GMD onset F 83.4, with velocity 61.7 |
| ADTOF and its PyTorch port | CC BY-NC-SA 4.0 | 5 classes | MDBDrums++ F 88.7 |
| ADT_STR (arXiv 2601.09520) | CC BY-SA 4.0 (ShareAlike) | PyTorch, safetensors, runs on Python 3.12 | MDB 0.79, ENST 0.73 |
| Noise-to-Notes (Sony) | Not released | Shows that E-GMD-only training can reach the state of the art | E-GMD 89.7 (with velocity 82.8), MDB 87.9 |
| Separate-and-Detect | Card says MIT, but it relies on madmom's onset models (CC BY-NC-SA) and trains on IDMT-SMT-Drums (CC BY-NC-ND) | — | MDB 0.71 |
| madmom (models), LarsNet, omnizart drums | Models CC BY-NC-SA, CC BY-NC, and not stated | — | — |

- **Plain onset detection on separated parts covers half the kit.** Separate-and-Detect ran a
  tuned onset detector on LarsNet-separated parts, measured on MDB against ADTOF (a table the
  research tool rebuilt from garbled text):

  | Part | Onset detection | ADTOF |
  | --- | --- | --- |
  | Kick | 0.90 | 0.85 |
  | Snare | 0.75 | 0.75 |
  | Toms | 0.26 | 0.52 |
  | Hi-hat | 0.41 | 0.77 |
  | Cymbals | 0.22 | 0.85 |
  | Overall | 0.61 | 0.80 |

  Plain onset detection is enough for kick and snare, not for the rest.
- **Two CC BY 4.0 training sets fit the app's input:**
  - E-GMD: full-kit audio with velocity.
  - StemGMD: 1,224 h of isolated per-piece drum stems, 9 instruments. This matches already-split
    kit parts closely.

  A small per-part onset model trained on these, passed through the app's own DrumSep, would be
  tier A. No released drum model is.

### Polyphonic models (piano, guitar, keys, other)

Checkpoints were inspected without being loaded: their pickle globals were listed over HTTP
range requests, to see whether `weights_only=True` would accept them.

| Model | Code | Weights | Trained on | Checkpoint | MPS risk | Reported | Tier and use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Basic Pitch | Apache-2.0 | Apache-2.0 (Spotify). The PyTorch port basic-pitch-torch has **no license**, so the app writes its own port and converts the official weights | GuitarSet, **MAESTRO (1,154 tracks)**, Slakh, iKala, MedleyDB (paper, Table 1) | Converted state dict; 16,782 params, 75 KB | Needs a CQT. nnAudio (MIT) or the app's own | GuitarSet onset .78, MAESTRO .58 (third-party) | B. **Default instrument-agnostic model** for guitar, keys and other; its pitch contour gives per-note bends |
| Kong / ByteDance high-resolution piano | MIT (inference), Apache-2.0 (training, archived) | **CC BY 4.0** on [Zenodo 4034264](https://zenodo.org/record/4034264); md5 only, so the app computes the sha256 | MAESTRO v2 | Old `torch.save` dict, safe globals; 172 MB | Low: its STFT is a convolution | MAESTRO onset 96.7, pedal 91.9; MAPS 83.1 (secondary) | B. **Default for piano stems**, with pedal |
| Edwards et al. 2024 (Kong retrained with augmentation) | as Kong | CC BY 4.0, [Zenodo 10610212](https://zenodo.org/records/10610212) | Augmented MAESTRO | Has numpy globals: needs a one-time re-save to load with `weights_only=True` | as Kong | MAESTRO 96.6; MAPS 88.4 | B. A better-generalizing piano alternative; also the starting point for a guitar model (see M6) |
| Transkun 2.0.1 | MIT | No license statement of its own; ships inside the wheel | MAESTRO v3 | Safe state dict; 56 MB | Complex `rfft` and `angle` in its features | MAESTRO onset .983; GuitarSet .873 (third-party) | B, unclear: the checkpoint is covered only by the wheel's MIT license, with no statement of its own. Optional, after measurement |
| Aria-AMT (EleutherAI) | Apache-2.0 | Hosted in a CC BY-NC-SA dataset repository, with no statement of its own | Not stated | safetensors, 447 MB; README requires Python 3.11 | `torch.stft` | MAESTRO onset 97.6, MAPS 90.6 | C until clarified |
| MuScriptor (Kyutai, Mirelo) | MIT | **CC BY-NC 4.0**, gated; the gate bans transcribing music you lack rights to | Synthetic and "internal" recordings | safetensors | README says it runs on MPS | Own test onset 60.4. No velocity | C |
| MR-MT3, trained from scratch | MIT | MIT tag on Hugging Face | **Slakh2100-redux only** (CC BY 4.0) | Lightning dict, safe globals; 583 MB | Not checked | Slakh flat onset 67.3. No real-recording results | **A, pending.** Which Hugging Face file is the from-scratch checkpoint is inferred from its name; confirm before relying on it. Lakh MIDI carries the caveat noted under Slakh. The only fully clean multi-instrument candidate; a baseline in M0 |
| MT3 (PyTorch conversion of Google's checkpoint) | Apache-2.0 | No license stated for Google's checkpoint | Includes MAESTRO | Safe state dict | Not checked | Slakh .76, GuitarSet .90, MAESTRO .95 | Unclear. Not a default |
| YourMT3+ | **GPL-3.0** | Apache-2.0 (Hugging Face card) | Includes MAESTRO, MIR-ST500 (restricted), ENST (research-only) | Lightning `.ckpt` | Not checked | see section 2 | B weights behind GPL code: an optional, separately installed component at most |
| Guitar-specific (GAPS, Guitab, FretNet, TabCNN) | — | GAPS weights: released since, see section 13 (this row said unreleased); Guitab CC BY-NC-SA; FretNet and TabCNN have none | — | — | — | GAPS: GuitarSet 88.1 zero-shot | None usable. Guitar goes through the general model until M6 |

- **No MAESTRO-free, permissively licensed piano model exists.** Authors differ on MAESTRO:
  - Kong and Edwards release MAESTRO-trained weights under CC BY 4.0 without comment.
  - PTify licenses its fine-tuned weights CC BY-NC-SA, saying whether share-alike reaches
    trained weights "is unsettled".
- **Guitar:** the GAPS work shows the Kong architecture, trained on guitar data, reaches 88.1
  onset F1 on GuitarSet zero-shot. Fine-tuning the CC BY 4.0 Edwards weights on GuitarSet (CC
  BY 4.0) and separated Slakh guitar is the most direct route to a shippable guitar model (M6).

Dataset licenses, read from the official pages unless marked otherwise:

| Dataset | License | Usable for shipped weights? |
| --- | --- | --- |
| Slakh2100 (and Flakh) | CC BY 4.0 ([Zenodo 4599666](https://zenodo.org/records/4599666), checked) | Yes, with attribution. The underlying Lakh MIDI files are user transcriptions of copyrighted songs, which the audio's license does not resolve |
| GuitarSet v1.1.0 | CC BY 4.0 ([Zenodo 3371780](https://zenodo.org/record/3371780)). Has pitch contours and hexaphonic audio with and without bleed | Yes |
| E-GMD | CC BY 4.0 ([Magenta](https://magenta.tensorflow.org/datasets/e-gmd)). 444 h, 43 electronic kits, velocity | Yes. Electronic kits only, so there is a gap to recorded drums |
| MusicNet (original labels) | CC BY 4.0 at record level; per-recording terms to check | Probably. The realigned MusicNet-EM labels are CC BY-NC-SA |
| ChoraleBricks | CC BY 4.0 (secondary: [MIMuT data card](https://huggingface.co/datasets/J1mmymm/MIMuT_Data_v2)) | Yes |
| MAESTRO v3 | CC BY-NC-SA 4.0 ([Magenta](https://magenta.tensorflow.org/datasets/maestro)) | No, under a strict reading |
| RWC Pop | CC BY-NC 4.0 (secondary) | No |
| ENST-Drums, URMP, MIR-1K, IDMT-SMT-Bass, MIR-ST500 | Research-only or restricted | No. Local evaluation only, if at all |

## 5. Recommended architecture

```
stem audio ──► router (stem name → kind; polyphony check for ambiguous stems)
                 │
   ┌─────────────┼──────────────────┬──────────────────────┐
   ▼             ▼                  ▼                      ▼
 drum part    monophonic         polyphonic             full mix / unknown
 onsets per   neural f0 +        note model posteriors   (not transcribed by
 part, peak   note HMM + onset   (onset, frame, pitch    default; optional
 velocity,    cues; pitch curve  contour) + note tracker multi-instrument
 GM mapping   per note                                   model)
   │             │                  │
   └─────────────┴───────┬──────────┘
                         ▼
        note objects: start, end, pitch center (cents), pitch curve,
        loudness curve, velocity, confidence, source
                         ▼
        cross-stem pass: bleed attribution, duplicate removal
                         ▼
        refinement: tuning offset, overtone and octave ghosts,
        offsets, confidence calibration
                         ▼
        exports: <stem>.notes.json (all data)  ──►  <stem>.mid (plain)
                                                    <stem>.mpe.mid or bends
```

### Routing by stem kind

The recipes already name their stems. The router maps names to kinds, replacing the `_RANGES`
table in `pipeline/extras.py`. For stems whose name says nothing about polyphony (`other`,
`melody`, `synth`, `strings`, `keys`, `wind`), a polyphony check decides between the monophonic
and polyphonic paths. It counts simultaneous peaks in a harmonic salience map, or the active
notes in the polyphonic model's posterior.

| Stems (names in the recipes) | Kind | Method | MIDI |
| --- | --- | --- | --- |
| `kick`, `snare`, `toms`, `hh`, `ride`, `crash` | drum part | Onset detection per part. Velocity from the peak level within about 50 ms. GM note per part. Toms split into high, mid and low by pitch clusters. Hi-hat open or closed by decay | Channel 10: 36, 38, 41-50, 42/46, 51, 49 |
| `drums` (any recipe without the kit split) | drum mix | Run the DrumSep pass first (the `drum-kit` chain), then as above. Later, a drum transcriber trained on E-GMD | Channel 10 |
| `other drums`, `percussion`, `congas`, `tambourine`, `triangle` | percussion | Onsets only, one GM percussion note | Channel 10 |
| `vocals`, `lead vocals`, `lead`, `dry vocals`, `lead-vocal`, `vocal` | monophonic voice | SwiftF0, then the app's own note segmenter (no vocal note model has clean weights) | Plain, plus bends |
| `bass`, `double-bass`, `tuba` | monophonic bass | f0 with a low range (below about 47 Hz: see section 13, torchcrepe's defaults stop at 50 Hz). Polyphonic path when chords are found | Plain, plus bends |
| `backing vocals`, `back-vocal`, `backing` | polyphonic voice | Polyphonic path | Plain or MPE |
| `piano`, `digital-piano`, `keys`, `organ`, `harpsichord` | polyphonic keys | Polyphonic path. Optional piano specialist | Plain (MPE optional) |
| `guitar`, `acoustic-guitar`, `electric-guitar`, `banjo`, `mandolin`, `ukulele`, `dobro`, `sitar`, `harp` | polyphonic plucked | Polyphonic path. Bends matter | Plain or MPE |
| `violin`, `viola`, `cello`, `strings`, `bowed_strings`, winds and brass in `mega-53` | depends | Polyphony check | Plain, plus bends or MPE |
| `other`, `melody`, `synth`, `bells`, `glockenspiel`, `marimba`, `accordion` | unknown | Polyphony check, instrument-agnostic | Plain or MPE |
| `instrumental`, `drumless`, `clean`, `dry` | mixture | Not transcribed by default | none |

The stem name also gives the MIDI file a General MIDI program, and a pitch range prior: a
violin plays no lower than G3, a flute no lower than about C4. That range prior removes octave
errors cheaply.

### The note object (sidecar file)

The full result is kept in `<stem>.notes.json` beside the stem. The `.mid` files are derived
from it, so changing the export, or later the user's corrections, never re-runs the analysis.
Melodyne keeps this detail inside the program too.

```json
{
  "version": 1, "stem": "lead vocals", "kind": "voice", "method": "mono-1",
  "hop_seconds": 0.01, "tuning_cents": -12.0, "bpm": 121.9,
  "notes": [
    {"start": 12.345, "end": 12.901, "pitch": 64.07, "velocity": 88, "confidence": 0.93,
     "curve_cents": [3.1, 2.4, -1.0], "loudness_db": [-18.2, -16.9, -17.4],
     "source": "f0+hmm"}
  ]
}
```

- **Pitch center:** a robust average of the curve over the note's stable part, measured against
  the song's tuning (`librosa.estimate_tuning`). This is Melodyne's pitch center.
- **Drift and modulation:** split from `curve_cents` with a fixed filter. Drift is the part
  below about 2.5 Hz; modulation is the rest. They are computed on read, not stored.
- **Velocity:** from loudness at the attack, normalized per stem. Melodyne also takes velocity
  from amplitude.
- **Confidence:** a calibrated probability that the note is right (section 7).

### Refinement, using published methods

1. **Tuning first.** Estimate the song's offset from A440 once and round pitch centers against
   it. A detuned recording otherwise produces notes that flip between neighbours.
2. **Cross-stem bleed.** For each note, measure the energy at its harmonics in every stem of
   the track. If another stem holds the same note much louder (beyond that stem pair's usual
   bleed ratio), drop it or mark it low confidence. This uses the fact that the recipes' stems
   add up to the mix.
3. **Overtone and octave ghosts.** Fit the detected notes to the stem with non-negative least
   squares over harmonic templates (score-informed NMF, a published method: Ewert and Müller,
   2012). A note whose activation vanishes once lower notes' harmonics are accounted for is a
   ghost. For octave pairs, compare odd-harmonic energy. The fit only decides which notes are
   real; it does not split the audio among them.
4. **Offsets.** End a note when its harmonic energy falls a set number of dB below its peak, or
   reaches the stem's noise floor. Use the piano model's pedal output where it has one.
5. **Pitch curves in polyphony:**
   - The source is the model's own pitch contour; Basic Pitch resolves three bins per semitone.
   - It is refined by instantaneous frequency at those of the note's harmonics that no other
     sounding note shares.
   - Shared bins are skipped, not divided.
6. **Optional, later:** local gradient refinement of pitch and amplitude by resynthesis. Local
   only, since it cannot fix large errors.

None of these steps peels notes off one at a time or divides spectral bins among notes. Those
are how Celemony's patent describes its method (section 10).

## 6. Ideas beyond a single model, ranked

Gain and cost are judgments, to be confirmed in stage M0.

| # | Idea | Gain | Cost | Why |
| --- | --- | --- | --- | --- |
| 1 | Drum MIDI from the drum parts the app already separates | High | Low, then medium | Velocity and finer classes come from the parts (Riley and Dixon). Plain onsets are enough for kick and snare; a small model trained on CC BY StemGMD and E-GMD covers the rest. Today drums get no MIDI |
| 2 | Cross-stem bleed attribution | High | Low | Avoids the bleed blow-up seen when every stem is transcribed (386 to 2,820 notes) |
| 3 | Route by stem name, with instrument range priors and GM programs from `mega-53` labels | Medium-high | Low | Specialists beat generalists. Range priors kill octave errors |
| 4 | Tuning offset and key-aware rounding | Medium | Trivial | Stops pitch-center flips on detuned recordings |
| 5 | Confidence per note, with a sensitivity slider | High (user-facing) | Medium | This is how Melodyne gets to a usable result |
| 6 | Score-informed harmonic NMF for ghosts and per-note curves | Medium-high | Medium | Targets the most common complaint about every tool |
| 7 | Two transcribers voting | Medium | Low once both exist | Agreement raises confidence |
| 8 | "Observation adding": transcribe the stem plus a little of the mix | Unknown | Trivial to test | Reduces artifact damage in speech recognition. Untested for music |
| 9 | Separator-in-the-loop training data | High | High | Render CC BY multitracks, separate them with the app's own models, and train on the result with the original labels |
| 10 | Reuse a RoFormer separator as the transcription encoder | High | High | Mel-RoFormer reached vocal state of the art this way. Depends on the separation weights' license |
| 11 | Repetition prior: repeated sections should agree | Medium | Medium | Fills missed notes and rejects ghosts in choruses. Not found in the literature |
| 12 | Notes back into separation, then transcribe again | Low-medium | High | Notes help separation more than separation helps notes. A research bet |
| 13 | Resynthesis residual as a "missed notes" hint | Medium | Medium | Unexplained energy becomes hollow candidate notes in the editor, as Melodyne does |
| 14 | Piano sustain pedal as CC64 | Medium | Low | Kong's piano model already predicts the pedal. Melodyne's export documents none |
| 15 | Key signature in the file, and a tempo map from beat tracking | Medium | Low to medium | The app already detects key and tempo; beat tracking would be new. MIDI from a song whose tempo drifts then lines up with bars. Whether FL imports a tempo map goes in the M0 test files |
| 16 | A chord track: chord names as markers or a separate track, from all pitched stems together | Medium | Medium | Only possible with the whole song in hand, which a single-track editor like Melodyne lacks |

## 7. Measuring it: the benchmark (stage M0)

- **Script:** `scripts/midi_bench.py`, a development tool like `scripts/benchmark.py`.
  Datasets are downloaded by hand to `D:` and never committed.
- **Sets,** fetched by `scripts/midi_bench_data.py` into `D:\lew-stems\bench`. All are CC BY 4.0
  (Zenodo, checked 2026-11-23), and downloads are verified against Zenodo's md5.
  - **Slakh2100's test split:** stems, mix and MIDI. The archive is one 104 GB `.tar.gz` with
    its files in no order, so no song is complete before nearly the end: it is downloaded
    whole (resuming after drops), checked, the 151 test songs extracted (8 GB) and the archive
    deleted. 150 are used: one stem of Track01954 was damaged on this PC by a power loss while
    it was being written. Slakh has no vocals. Its bass renders sound an octave below the
    written MIDI, so the scorer moves the bass reference down 12 semitones (measured: 140 of
    142 songs; Track01931 and Track01937 sit 14 down and are left in).
  - **vocadito,** for vocals in M3: 40 solo vocal excerpts with f0 and note annotations, 58 MB.
    Mixed over Slakh backing, it also gives separated vocals to test.
  - **Later:** an E-GMD subset (one 96 GB zip; the server takes range requests, so single files
    can be read) and StemGMD (six 31 GB parts, for M2b).
  - **GuitarSet:** mono microphone audio, with pitch contours and notes (0.7 GB). The
    hexaphonic audio, with and without bleed, can follow if needed.
  - A synthetic expressive set made by a script: melodic lines and chords with known vibrato,
    drift and bends, rendered by a simple harmonic synth so the true curves are exact. It is
    public domain by construction, and mixed over Slakh backing to create bleed.
- **Three conditions per song:**
  1. The clean stem (oracle).
  2. The app's separated stem, from `full-song` and `every-stem`.
  3. The mix.

  This produces the stems-versus-mix measurement the literature lacks.
- **Metrics:**
  - Note F1 from mir_eval at its defaults: onset only, onset plus offset, and with velocity
    (`mir_eval.transcription_velocity`).
  - Drum onset F1 per class.
  - Cross-stem duplicate rate.
  - Pitch-curve error: median absolute cents, and the share of frames within 25 and 50 cents,
    on matched notes.
  - Confidence calibration: reliability curve.
  - Resynthesis distance: a diagnostic only, since magnitude spectra are a weak pitch signal.
- **Baselines:**
  - Today's YIN tracker.
  - The section 4 candidates: SwiftF0, torchcrepe, pYIN, the Basic Pitch port, Kong's piano
    model, MR-MT3.
  - ADTOF and Transkun as references. Evaluation only; ADTOF is never shipped.
  - Melodyne's exported MIDI for the same stems (the owner has Melodyne). This is the bar
    to beat.
  - NeuralNote's exported MIDI. It runs Basic Pitch inside, so it also checks that the app's
    own port of Basic Pitch matches the original.
- **Baseline pack, to keep the owner's manual work small:** for about 10 songs, the harness
  writes:
  - the separated stems, with exact file names;
  - for each stem, which Melodyne algorithm to use (Melodic, Polyphonic or Percussive);
  - a drop folder with fixed names: `<song> - <stem>.melodyne.mid` and
    `<song> - <stem>.neuralnote.mid`.
- **External MIDI is aligned before scoring:**
  - Each file's ticks are converted with its own tempo map, except Melodyne's. Its notes file
    says 120 BPM, while the document's tempo goes into a second file it writes beside it,
    `<document>.tempo.mid`, which the scorer reads instead (seen in the owner's exports).
  - Melodyne starts its export at the bar of the first note. In the pack that is bar 1, the
    document's 0.
  - NeuralNote is reported to export at 120 BPM.
  - The harness finds one global offset per file by matching onsets within a bounded window
    (0.3 s for Melodyne, 6 s otherwise), and reports the offset it applied. Otherwise the
    baselines would score near zero for the wrong reason. A file with notes past the end of its
    audio is flagged.
- **Machine:** separation runs go in batches, and the harness caps its CPU workers. Each run of
  `openstems selftest` with models is still asked for first.

### Results so far (CPU only, 2026-11-23 and 24)

"Today's YIN" in these tables is the tracker "Write MIDI" used until stage M3 replaced it
(section 14), and the guitar rows are the first 30 solos; section 14 has all 180.

GPU runs wait on the machine (the notes in `CLAUDE.md`), so these are the clean-audio
condition only. Scores are mir_eval's defaults; "+offset" also needs the note's end.

**Vocals,** all 40 vocadito excerpts:

| Method | Onset F1 | +Offset F1 |
| --- | --- | --- |
| Today's YIN (`track_notes`) | 0.392 | 0.240 |
| pYIN, the engine's segmentation | 0.491 | 0.314 |
| SwiftF0, the engine's segmentation | 0.499 | 0.328 |
| **SwiftF0 with its own segmenter (`segment_notes`, MIT)** | **0.778** | **0.646** |
| vocadito's second annotator against the first (the human ceiling) | 0.740 | 0.642 |

**Guitar,** 30 GuitarSet solos (monophonic trackers on mostly single-note lines):

| Method | Onset F1 | +Offset F1 | Octave errors |
| --- | --- | --- | --- |
| Today's YIN | 0.350 | 0.192 | 119 |
| pYIN | 0.555 | 0.359 | 86 |
| SwiftF0, the engine's segmentation | 0.645 | 0.420 | 11 |
| SwiftF0 with its own segmenter | 0.649 | 0.427 | 5 |

What this shows:

- **Segmentation matters more than the tracker on vocals.** A better tracker alone moves onset
  F1 from 0.39 to 0.50. SwiftF0's segmenter takes it to 0.78, level with a second human, but
  that row also keeps each note's exact pitch where the rows above it are rounded to keys.
  Like for like, on keys rounded at A440, the segmenter scores 0.726 (0.606 with note ends):
  the split is worth 0.23 and exact pitch another 0.05 (re-measured on all 40 clips on
  2026-11-25). M3 starts from that segmenter, not from a new HMM. The HMM from the Tony paper
  stays the fallback if per-note curves need a different split.
- **Keys in the singer's own tuning score lower than keys at A440 on all 40 clips:** 0.646
  against 0.726. The pack's six clips showed the same (0.639 against 0.718, below). The
  reference is in Hz and the window is 50 cents, so this measures the scoring as much as the
  notes; which rounding a producer wants in the file is still the owner's to settle.
- **SwiftF0 nearly removes octave errors on guitar** (119 to 5).
- Melodyne's numbers on the baseline pack are below. NeuralNote's are still to come.

**Bass,** Slakh's own bass stems (oracle), 142 songs, 68,350 notes:

| Method | Onset F1 | +Offset F1 | Octave errors |
| --- | --- | --- | --- |
| Today's YIN | 0.648 | 0.382 | 1,322 |
| SwiftF0, the engine's segmentation | 0.804 | 0.658 | 8 |
| SwiftF0 with its own segmenter | 0.825 | 0.710 | 8 |

No Slakh bass note is below SwiftF0's 46.9 Hz floor (all are G1 or higher after the octave
shift), so this set does not test it: a real bass's low E (41 Hz) still needs the pYIN or
torchcrepe fallback that M3 plans.

**Drums,** Slakh's own kit stems (oracle), 150 songs, timing only (hits within 50 ms; hits
closer than 30 ms counted once):

| Method | Precision | Recall | Onset F1 | Kick | Snare | Toms | Hi-hat | Ride | Crash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| librosa spectral flux | 0.996 | 0.731 | 0.827 | 0.974 | 0.978 | 0.890 | 0.786 | 0.757 | 0.932 |
| SuperFlux | 0.998 | 0.716 | 0.817 | 0.966 | 0.973 | 0.871 | 0.773 | 0.730 | 0.918 |

The part columns are recall per part. Almost every hit found is real, but about a quarter are
missed, mostly hi-hats and ride: fast, quiet hits inside louder ones. That fits the published
picture M2a was planned on: kick and snare are easy, cymbals are not. Detecting per part on
DrumSep's split stems, as M2a plans, is the next measurement and needs the GPU for the split.
SuperFlux's vibrato suppression buys nothing on drums.

**Melodyne,** the baseline pack, exported by the owner on 2026-11-24. It is the first pass with
the algorithm the pack named then: Melodic for vocals, and Polyphonic Decay for every guitar
clip, the three solos included. Melodic is Melodyne's algorithm for single lines, so the pack
now names it for the solos, and their row stays provisional until those exports come in. The
audio is clean, not separated stems. 11 of the pack's 13 clips are scored:

- `00_BN1` waits for a clean export. The file saved under its name also holds `01_BN3`'s notes.
- `01_Jazz3` has no export yet.

Every method is averaged over the same clips.

| Stem | Clips | Method | Onset F1 | +Offset F1 | Octave errors |
| --- | --- | --- | --- | --- | --- |
| Vocals | 6 | Melodyne (Melodic) | 0.502 | 0.234 | 1 |
| | | Today's YIN | 0.424 | 0.266 | 0 |
| | | SwiftF0 notes as whole keys (M1's rounding: what the app's MIDI carries) | **0.639** | **0.479** | 0 |
| | | The same notes at exact pitch (the notes file, or bends) | 0.766 | 0.583 | 0 |
| | | vocadito's second annotator | 0.749 | 0.661 | 0 |
| Guitar solos | 3 | Melodyne (Polyphonic Decay; provisional, Melodic to come) | 0.713 | 0.486 | 11 |
| | | Today's YIN | 0.313 | 0.209 | 6 |
| | | SwiftF0 notes, whole keys and exact pitch alike | **0.786** | **0.612** | 0 |
| Guitar comps (chords) | 2 | Melodyne (Polyphonic Decay) | **0.586** | **0.326** | 53 |
| | | SwiftF0 notes, a single-note tracker | 0.291 | 0.142 | 0 |

What this shows:

- **On vocals, the transcriber M3 plans already beats Melodyne's first pass; today's tracker
  does not.**
  - Vocals: onset F1 0.639 against 0.502 as whole keys, and 0.479 against 0.234 with note ends.
    Today's YIN scores 0.424.
  - Guitar solos lean the same way, provisionally: 0.786 against 0.713, and 0.612 against
    0.486 with note ends. Melodyne ran its chord algorithm on them, though. Melodic exports will
    settle it.
  - Melodyne finds the most guitar notes (recall 0.80 on solos), but it adds notes an octave
    away (11 on three solos, 53 on two comps), and those cost it precision. On the solos that
    may be the chord algorithm's doing.
- **Chords are Melodyne's for now.** Polyphonic Decay scores 0.586 against 0.291 for a
  single-note tracker, as expected: polyphonic transcription is M4. This is the gap and its
  cause, as Phase 7's acceptance asks.
- **The 50-cent window penalizes whole keys on vocals.** These six singers sit 15 to 45 cents
  off A440.
  - M1 rounds in the singer's own tuning. A note sung a little sharp of that tuning then lands
    more than 50 cents from its pitch in Hz and counts as wrong.
  - So the app's vocals drop from 0.766 at exact pitch to 0.639. Plain rounding at A440 gives
    0.718.
  - Melodyne rounds the same way. Where the two roundings differ, its key is the one in the
    singer's tuning 45 times, against 13 for A440.
  - Scored as keys in the singer's tuning (each key moved by the reference's own tuning),
    Melodyne has 0.612 and the app 0.675, and the app leads on all six clips.
  - M3 should score whole keys that way, and keep exact pitch for the bend modes.
- **Small and clean.** These are 11 clips of solo recordings, one export each. They show a
  direction, not a margin. The separated-stem condition that Phase 7's acceptance names needs
  the GPU, and waits on the machine.

Reading Melodyne's export took three corrections, now in the scorer:

- **Tempo.** Each notes file said 120 BPM. Its notes sat on Melodyne's document tempo,
  64.511 BPM, half the first clip's 129. Only the `Untitled.tempo.mid` written beside each
  export held that tempo. Read at 120, every note came out at 0.538 times its real time, and
  every file scored about 0.1.
  - Each export overwrites that file and keeps the one before as `.origN`, and each was
    written within 5 ms of its notes file.
  - The scorer pairs them by that moment, so a new document with another tempo needs no
    renaming.
- **Offset.** At the right tempo the onsets line up within about 10 ms, with no drift across
  any file. Searched over ±6 s, the offset locked onto a repeat in one comp's chord pattern,
  2.07 s off. It is now searched over ±0.3 s for Melodyne.
- **One export held two clips.** The `00_BN1` file is exactly that clip's earlier export plus
  every note of `01_BN3`. The earlier export also has 12 notes after its audio ends.
  - The pack's instructions now ask for one Melodyne document per clip.
  - The scorer flags any file with notes past the end of its audio.

## 8. MIDI export and DAWs

Checked 2026-11-23 against each vendor's current release. "By omission" means the vendor's
release notes and manual say nothing on the point.

| DAW | Per-note pitch on import | Pitch-bend range | Source |
| --- | --- | --- | --- |
| FL Studio 2026 (2026.1.7; 2026.2 RC of 2026-11-20) | No native MPE (by omission in the 2026 release notes; a 2026 feature request has no staff reply). Import can create "one channel per track": each MIDI channel in the file becomes its own instrument, so an MPE file opens as up to 15 instruments. Bends arrive as channel pitch events, not note slides (forum, unverified) | An Image-Line staff post (2023) says FL "doesn't handle pitch bend range from MIDI files". Users report every bend read as +/-2 | [Import MIDI manual page](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_midiimport.htm), [staff post](https://forum.image-line.com/viewtopic.php?p=1853428) |
| Ableton Live 12.4 | The Note Expression tab edits per-note pitch "regardless of" how a clip was made. Whether member-channel bends in an imported file become note expression is undocumented | 48 for MPE (Ableton's advice; Auto Shift uses 48 since 12.1.5) | [Editing MPE](https://www.ableton.com/en/live-manual/12/editing-mpe/) |
| Logic Pro 13.0 | MPE file import undocumented. 13.0 keeps the original order of controller events that share a position on import, which implies older versions reordered them | Instruments 0 to 96, default 48 | [Logic 13.0 notes](https://support.apple.com/en-us/109503) |
| Bitwig 6.1 | Imports pitch bend (since 3.2.8). MPE import not documented | Micro-pitch +/-24 | [3.2.8 notes](https://downloads.bitwig.com/stable/3.2.8/Release-Notes-3.2.8.html) |
| Cubase 15, Reaper | Cubase documents MPE only for input devices, plus a manual "Convert to Note Expression" command. Reaper asks whether to split channels onto tracks, and has no per-note editor | — | Steinberg help; Cockos wiki (secondary) |
| Any DAW | None was found that reads the MIDI 2.0 Clip File (specified in 2023) | — | release notes, by omission |

Melodyne 5's export carries no pitch bend in any edition. Several instances go into one file,
one channel per instance ([Celemony](https://helpcenter.celemony.com/M5/doc/melodyneStudio5/en/M5tour_ExportMIDI_otherDAWs)).

The owner's exports of 2026-11-24 show one more thing; Melodyne's version and host were not
recorded. The notes file said 120 BPM, while its notes sat on the document's tempo, which went
into a second file, `<document>.tempo.mid`. A DAW that reads only the notes file plays them at
the wrong speed unless its own tempo is Melodyne's. The app's writer puts the tempo in the same
file (a conductor track).

Three exports follow from this:

1. **Plain notes (the default).** Format 1, one channel; drums on channel 10 with GM notes. It
   is the only form every DAW documents, and it is what Melodyne writes.
2. **Bends at +/-2 semitones, one voice per channel.** +/-2 is General MIDI's default and what
   FL is reported to assume, so this is the most likely file to work everywhere.
   - Pitch moves larger than 2 semitones become new notes, which the note segmenter does
     anyway. Within a note, vibrato and drift rarely exceed 2 semitones.
   - RPN 0 is still written, then RPN null.
   - This suits monophonic stems (vocals, bass, leads).
   - Overlapping notes in one voice are trimmed so each bend belongs to one note.
3. **MPE (an option).** For Live, Bitwig, Logic and Cubase, labelled "untested on import" until
   checked.
   - Lower zone, with the MPE Configuration Message on channel 1. Checked against RP-053: RPN
     00 06, sent as `B0 64 06, B0 65 00, B0 06 0F` for 15 member channels. A receiver then
     resets members to +/-48 and the master to +/-2.
   - RPN 0 = 48 on every member channel, with bends kept within +/-24 for Bitwig.
   - CC74 and channel pressure.
   - Each setup message on its own tick before the first note, since older Logic versions may
     reorder controllers that share a tick.

Test files for the owner (part of M0). Open each in FL Studio through File > Import, by
dropping on the Channel Rack and by dropping on the Piano roll. Also open the MPE files in
Logic on the Mac and in Live.

1. **Bend at +/-2:** channel 1, one note, RPN 0 = 2, a bend ramping to +2 semitones. Where does
   the bend land, and how large is it?
2. **Bend at +/-12:** as 1, with RPN 0 = 12 and a +12 bend. Does FL read RPN 0?
3. **Bend at +/-48:** as 1, with RPN 0 = 48 and a +7 bend. How does it scale at the MPE range?
4. **MPE layout:** four overlapping notes on channels 2 to 5, each with its own bend, CC74 and
   pressure, plus the configuration message. Make a type 0 and a type 1 version, and import
   each with "one channel per track" on and off.
5. **Two voices:** channels 1 and 2, saved as type 0 and as type 1. How does FL split them?
6. **Tempo map and key:** a tempo change partway through, plus a key signature. Does FL import
   the tempo map, and do the notes still land on the right bars?

What the MPE specification fixes, from [RP-053](https://midimpe.neocities.org/rp53spec.pdf):

- **Channels:** one note per member channel, so at most 15 notes can bend independently in a
  zone.
- **Bend range:** per-note pitch bend defaults to +/-48 semitones and the master channel to +/-2.
  Either can be changed with RPN 0, and an exporter should write the range explicitly.
- **Before Note On:** a note's starting pitch is the last bend sent on its channel, so the bend
  and other per-note values go before the Note On. Nothing applies after Note Off.
- **Per-note dimensions:** pitch bend, channel pressure and CC74.
- **Resolution:** 14-bit bend at +/-48 is about 0.6 cent per step, ample for vibrato and drift.

A monophonic stem has one voice, so it needs no MPE: ordinary pitch bend on one channel, with
its range declared by RPN 0, is the most widely readable form.

## 9. Build plan

Stages are named M0 to M7 so they are not confused with the phases in `PLAN.md`. Ranked by
expected quality gain for the effort; M0 and M1 come first because everything depends on them.
Effort: S is days, M one to two weeks, L several weeks.

### M0: benchmark (M)

- **What:** section 7, plus a test MIDI set for the owner to open in FL Studio, Ableton and
  Logic (section 8).
- **Done when:** the baselines are scored on all three conditions. The report is added to
  `docs/benchmarks.md`.
- **Machine:** separating 20 to 30 songs is ordinary app use, but long unattended GPU runs on
  this PC need the owner's go-ahead (the machine notes in `CLAUDE.md`).

### M1: note objects and export (S to M)

- **Domain code:** `domain/notes.py`, plain functions with no torch:
  - the note object;
  - drift and modulation split;
  - velocity mapping;
  - tuning-relative rounding;
  - the polyphony check's decision rule.
- **MIDI writer:** `audio/midi.py` grows a format 1 writer with:
  - program change;
  - channel 10 for drums;
  - single-channel bends with the range declared by RPN 0;
  - a key signature meta event, and room for a tempo map later (section 6, idea 15);
  - an MPE writer: member channel allocation; bend, CC74 and pressure before each Note On; at
    most 15 voices, with overflow notes falling back to plain notes.
- **Unchanged:** `midi_bytes` keeps its current behavior for plain notes.
- **Tests:**
  - round trips;
  - MPE invariants: bend before Note On, RPN 0 on every member channel, voice limit;
  - the sidecar schema.
- **Mac:** pure Python, no platform branch.
- **Status (2026-11-24):** built and tested (`engine/tests/test_notes_midi.py`): the note
  object, tuning estimation and rounding, velocity from level, the version 1 notes file, and
  the format 1 writer in all three pitch modes. mido reads its output in each mode.
- **Since (2026-11-25, with M3):** a run writes `<stem>.notes.json` beside each stem it
  reads, and the manifest, the API, a rename and a retag carry it. The polyphony rule is in
  as a mark on the stem (section 14). Still to do: the split of drift from modulation in a
  note's curve.

### M2: drums from the drum parts (S to M for M2a; M for M2b; highest gain per effort)

- **M2a, no weights:** `transcribe/drums.py`:
  - spectral-flux onsets per part, with an adaptive threshold (librosa is ISC-licensed);
  - cross-part bleed suppression: a hit counts in the part where it is loudest relative to
    that part's usual bleed;
  - velocity from peak level;
  - GM mapping, with tom clustering and hi-hat open or closed.

  Published numbers say this is enough for kick and snare and weak for toms, hi-hats and
  cymbals. Those parts ship marked low confidence until M2b.
- **M2b:** a small learned per-part onset model (a CNN or CRNN on mel frames, about the size of
  ADTOF's), with:
  - training data: StemGMD and E-GMD (both CC BY 4.0) passed through the app's DrumSep;
  - shipped as a catalog model, tier A.

  This is the first training job, and a small one. Ask before running it on the development PC.
- **Recipes:** asking for drum MIDI on a recipe without the kit split adds the DrumSep pass. The
  recipe and option wiring change, along with the cache key.
- **Scored on:** separated Slakh drums, E-GMD, and StemGMD held-out kits.

### M3: monophonic expressive (M)

- **Status (2026-11-25):** built for single lines and measured on clean recordings: section
  14 and `docs/adr/0030-single-line-transcriber.md`. Not done: the run on separated stems
  (it needs the GPU), and offering pitch bends (the writer has them; the option waits for
  the editor and the FL Studio import test).

- **Replaces** `track_notes` (YIN) with:
  - a neural f0 tracker: SwiftF0 for vocals and leads, with torchcrepe or pYIN for bass below
    about 47 Hz (section 4). SwiftF0 runs on ONNX Runtime on the CPU, so it needs no GPU
    memory and has no MPS path to verify; ONNX Runtime becomes a new dependency;
  - tuning estimation;
  - an HMM note segmenter written from the published Tony method (its GPL code is not
    used), with onset cues from spectral flux;
  - per-note curves;
  - velocity from amplitude.
- **Polyphony check:** routes ambiguous stems.
- **Export:** single-channel pitch bend.
- **Model rules:**
  - Torch trackers are catalog models with a sha256, `weights_only=True`, a measured
    `memory_gb`, a self-test entry and an "unverified on MPS" note until the owner runs them.
  - SwiftF0's file is ONNX, so there is no pickle to load. Like torchcrepe's, it ships inside
    its pip wheel, outside the catalog. Two options:
    - copy the file to a pinned URL that the catalog downloads, per rule 6;
    - rely on the lockfile's package hashes, recorded as an ADR deviation.

### M4: polyphonic pitched (M to L)

- **Engine:** the models chosen in section 4:
  - piano stems: Kong's piano model (CC BY 4.0 weights), with pedal;
  - keys and other: the app's own PyTorch port of Basic Pitch (Apache-2.0 weights, converted
    once, then pinned by sha256). Its pitch contour is the reason to use it;
  - guitar: chosen in M0 from the Basic Pitch port, Kong or Edwards, and Transkun. Third-party
    GuitarSet figures put Basic Pitch (.78) below Transkun (.87), and the GAPS work took the
    Kong architecture to 88.

  Both are tier B, allowed by the owner's decision. Each runs with:
  - a note tracker over its posteriors, calibrated per stem kind;
  - per-note bends from its pitch contour plus instantaneous frequency;
  - the cross-stem bleed pass;
  - score-informed NMF ghost pruning.
- **Optional, after measurement and the owner's decisions (section 10):**
  - Transkun or the Edwards weights for piano.
  - YourMT3+ as a separately installed component.
- **Engine port:** a `Transcriber` protocol beside `Engine` in `engines/base.py`, with the same
  device, out-of-memory and CPU-fallback path (`engines/device.is_oom`, the job note). The API
  process never imports torch.

### M5: confidence and the note editor (L)

- **Confidence:** a calibrated score from model probability, unique explained energy, bleed
  ratio and duration.
- **Note view in `StemsPanel`:**
  - notes over the waveform;
  - a sensitivity slider (Melodyne's "how many candidates are used");
  - hollow low-confidence notes;
  - delete, split, join and add;
  - re-export without re-analysis.
- **Rules:** motion follows `docs/adr/0005-desktop-shell.md`. Words go through `src/platform.ts`.
- **Tests:** the FakeEngine gets a fake transcriber with deterministic notes for the end-to-end
  tests. Mac component tests go in `src/test/mac.test.tsx`.

### M6: training on separator output (L, research)

- **Data:** from CC BY sets only (Slakh2100, GuitarSet, E-GMD, MusicNet with original labels,
  ChoraleBricks), plus the synthetic expressive set, all passed through the app's own
  separators.
- **Training:**
  - Fine-tune the polyphonic model and the f0 tracker per stem kind.
  - Guitar first: start from the CC BY 4.0 Edwards piano weights, as the GAPS work did.
  - Train a drum transcriber on E-GMD through DrumSep, for when the kit is not split.
  - Over time, replace tier B models with tier A ones trained only on CC BY data, where they
    match the quality.
- **Ask first:** before any training run on the development PC (power loss under sustained
  load), or use a rented GPU.

### M7: research bets

- Local resynthesis refinement.
- The repetition prior.
- Test-time adaptation of thresholds per song.
- Notes fed back into separation.

### Changes every stage carries

- **Cache key:**
  - The MIDI method gets a version in `RunOptions.key_dict()`.
  - It is added only when the new method is on, as `tempo_sync` does, so earlier cache keys
    stay the same.
  - The manifest records the method and the sidecar file.
- **API:**
  - Schema changes regenerate `engine/openapi.json` and `app/src/api/schema.d.ts`.
  - The Settings hint for Write MIDI changes. Today it reads "Monophonic: one note at a time".
- **Both platforms:**
  - Each model gets a self-test entry.
  - `scripts/mac_check.sh` gets a timed transcription of every stem, and the MIDI files go into
    the report the owner sends back.
  - Each Mac figure is marked as an estimate until measured.
- **Attribution:** CC BY weights (Kong, Edwards) and every model trained on Slakh, GuitarSet,
  StemGMD or E-GMD must be credited. The credit is shown with the model in the catalog and the
  app.
- **Docs:** each deviation from `PLAN.md` gets an ADR.

## 10. Decisions

The owner's answers of 2026-11-23:

- **Tier B weights are allowed.**
- **Melodyne and NeuralNote** are available for baselines.

The owner's answers of 2026-11-25, after the check in section 13:

- **The guitar and bass note models** (`xavriley/midi-transcription-models`, MIT card) may ship.
- **dettato** goes in as an experimental choice, behind a setting.
- **tsumugi** goes in as an experimental choice too, without asking its author for a licence
  first. Its weights state none, so the app only ever downloads them from the author's own
  host at the user's request, never bundles or mirrors them, and says so where the choice is
  offered.
- **Weights trained on real songs' separated stems with weak labels may ship** (M6).
- **GPL code stays out:** YourMT3+ is a reference in M0, never shipped.
- **Best results first, licences second** (the owner, later the same day): any model may be
  used, whatever its licence, and the model that measures best on a stem is that stem's
  choice. This replaces "non-commercial weights are never shipped" and "GPL code stays out"
  above and in the table below. What it asks of the build:
  - M0 measures every candidate, the non-commercial and GPL ones included (YourMT3+,
    MuScriptor, ADTOF, hFT-Transformer, BassUNet, Noise-to-Notes if it is released).
  - Every model's catalog entry records the licence of its code, of its weights and of its
    training data, so a build limited to permissive licences can be cut later by leaving
    entries out. No code path may assume a restricted model is present.
  - GPL code is never copied into the engine's own package: it is installed as a component
    of its own and run in a process of its own, as section 10 already had it for YourMT3+.
    Whether that is enough for a build the project hands out is a legal question this
    document does not settle.
  - Weights are still downloaded at run time from their own hosts, sha256 checked, and never
    committed (ground rules 5 and 6).
- **No Klangio or AnthemScore exports:** the owner would rather not do more exports by hand.
  The baseline pack stays Melodyne and NeuralNote.
- **M0 may run** its separation runs on the development PC.
- **The FL Studio test files** will be checked by hand.

The rest are defaults until changed. The three that touch `PLAN.md` are in its Open decisions
table.

| Decision | Default | Alternative |
| --- | --- | --- |
| Tier B weights: a permissive license on the weights, but restricted data in training (SwiftF0, torchcrepe, Basic Pitch, Kong's piano model, Transkun, YourMT3+ weights; nearly every pitch tracker uses MIR-1K or MDB, and every strong piano model MAESTRO) | **Decided (owner, 2026-11-23): allowed**, with the training data and attribution recorded in the catalog and shown with the model. Tier A replacements trained by the app (M2b, M6) take over where they match the quality | Tier A only |
| GPL code (YourMT3+) | Not in the app. Running it privately is unrestricted under the GPL, so M0 measures it locally, in an environment of its own on `D:`, outside the engine's `uv.lock`. Revisit in M4 only if it clearly beats every shippable model on guitar or "other", where it reports the highest GuitarSet score found | A separately installed component, or asking the author to relicense the inference code (the weights are already Apache-2.0). A clean-room rewrite is not proposed: it is large, and hard to defend once the code has been read |
| Non-commercial weights (ADTOF, hFT-Transformer) | Never shipped | — |
| Celemony's US 8,022,286. Google Patents shows it active, expiring 2029-06-15, with the last maintenance fee paid 2023-03-08. EP2099024 is shown active to about 2029-02-05 (secondary; the EPO Register is the authority) | Avoided by design, following the owner's direction not to copy Melodyne: no peeling notes off one at a time, no division of spectral bins among notes, no per-note audio. Legal advice only if per-note audio editing is ever added | — |
| MIDI pitch format | Plain notes by default. Bends at +/-2 for monophonic stems as an option. MPE as a further option, marked untested on import | MPE by default |
| Training compute | A rented GPU, or the development PC only with the owner present | — |

## 11. Risks

- **License:** see section 10.
  - Every stage has a tier A fallback: pYIN, plain drum onsets, MR-MT3.
  - The better tier B defaults wait on the owner.
  - The fallbacks cost quality, by an amount M0 will show.
- **Patent:** see section 10.
- **Separation artifacts make a model worse,** as with Whisper on Demucs vocals. Measured in M0.
  Mitigated by observation adding, then by separator-in-the-loop training.
- **Bleed duplicates:** the cross-stem pass.
- **Mac:** every new model is unverified on MPS until the owner runs `mac_check.sh`. Complex STFT
  and CQT operations may need the CPU fallback (`engines/stft_fallback.py`).
- **DAW import differs by DAW,** with FL Studio the hardest. Settled by the test files.
- **Scope:** the editor (M5) is a large UI feature. M1 to M4 deliver value without it.
- **Speed and memory:** each model gets a measured `memory_gb` and a fit. Transcribing 13 stems
  adds time to a job, so MIDI stays opt-in per stem.

## 12. Unsolved in research

- **Dense polyphony of similar timbres:** string sections, pads, choirs. Even the best systems
  fall to about 0.44 onset F1 with three instruments.
- **Instruments beyond piano, bass, vocals and drums in real pop:** under 10% for YourMT3+.
  Public data under-covers them.
- **Note offsets:** best vocal COnPOff is about 0.63, and Basic Pitch's offset F1 on piano 0.11.
- **Per-note pitch curves in polyphony:** no benchmark exists. M0's synthetic set would be a
  first.
- **Separated stems against the mix for pitched transcription:** no peer-reviewed measurement.
- **Learning without labels:** resynthesis-only training still trails supervised training by a
  wide margin.

## 13. The check of 2026-11-25: keep the design, change the models

A second round of research asked whether any other route would give more correct MIDI. The
full report is `stem-to-midi-alternatives-2026-11.md` beside this file. Its verdict: no
fundamentally different route beats a specialist per stem, and several model choices above
are out of date. Every figure in it is reported from the cited pages, none was measured on
separated stems, and each must be confirmed in M0 before it is relied on.

**Ruled out**, each with a published number: audio language models (all below Basic Pitch
on notes), foundation encoders and codec tokens as the transcriber's input, one large
mix-to-MIDI model (MuScriptor: non-commercial weights, weak on single stems), diffusion for
piano, language-model rescoring, and adapting weights to the user's own song. Harmonica
(BandLab, 2026-09), the direct successor to Basic Pitch, has no released weights.

**What changes, by stage**

- **M0.** New rows:
  - the `guitar-gaps`, `guitar-fl` and `filobass` checkpoints (Kong's CRNN, about 99 MB each);
  - dettato's transcriber (Apache-2.0 code and weights, 15.3M parameters);
  - tsumugi's per-stem checkpoints (MIT code; weights with no stated licence);
  - pitch-shift aggregation on top of each polyphonic model (see M4);
  - a synthetic bass set reaching 30 Hz, since no Slakh bass note is below 46.9 Hz;
  - drum onsets on the whole kit against onsets per separated part.
  Released checkpoints are measured as released: the third-party table this document quoted
  for Transkun and Basic Pitch appears to retrain its baselines. YourMT3+ is no longer the
  clear leader on guitar (four models sit within two points on GuitarSet).
- **M2a.** Two published rules to start from: a hi-hat is open when its loudness stays above
  75% of its peak, and a cymbal hit goes to crash or ride by the louder separated part.
  Missed hi-hats and rides are mostly hits within 50 ms of another, not quiet ones.
- **M2b.** STAR Drums (124.5 hours, 18 classes) as training data once its licence is read.
- **M3.** The bass fallback was wrong as written. torchcrepe's `predict` defaults to
  `fmin=50.`, above a 4-string's low E (41.2 Hz), and its lowest bin is about 31.7 Hz, above
  a 5-string's low B (30.9 Hz). M3 picks among pYIN, PENN (MIT, 31 Hz floor) and the
  `filobass` note model on the 30 Hz set, and passes the range explicitly whichever wins.
- **M4.**
  - Basic Pitch is no longer the default for guitar, keys and "other": a 2026 comparison of
    11 models under one protocol puts it last or near last, at about .39 onset F1 on clean
    Slakh stems, in line with this document's own 0.42. It stays only where its pitch contour
    is wanted.
  - Pitch-shift aggregation moves here from M7: transcribe a few pitch-shifted copies and
    combine them. No training; about 3 points on out-of-domain piano and guitar in its paper,
    and a small loss in-domain. The spread across the copies is an input to M5's confidence.
  - The beat grid and the key count as evidence that a note is there. They never move a note.
  - Velocity from the GAPS-trained guitar models is not used (their labels are a constant
    100); it comes from loudness.
- **M5.** The editor's "unsure" notes are the model's middle band. In one study 99.4% of
  outputs fell within 0.2 of 0 or 1 and were 98.9% right; the band between was 57.9% right.
- **M6.** Add fine-tuning on real audio with loose labels (note counts, or unaligned scores):
  the largest published gains found, about 68 to 83 or 85 note F1 on guitar with no aligned
  labels, on two older consumer cards. Add pitch-shifted copies with shifted labels.
- **M7.** Dropped: language-model rescoring (error 21.4% to 21.2% in the one study) and
  adapting weights per song (predictions collapsed to blank in another). Resynthesis stays
  only as a per-stem quality score: no paper since 2023 reports a note-level gain from it.

**Experimental models in the app.** dettato and tsumugi are offered behind a setting, off by
default, each named as experimental where it is chosen. Neither replaces a default until M0
has measured it on separated stems.

## 14. M3 as built: the single-line transcriber, measured (2026-11-25)

`audio/transcribe.py` (`transcribe_line`) is what "Write MIDI" now runs. The decisions are in
`docs/adr/0030-single-line-transcriber.md`; this section holds the measurements. Everything
is on the CPU, on clean recordings unless it says otherwise. Scores are mir_eval's: a note is
right when its start is within 50 ms and its pitch within 50 cents. Every table is the code
as it is after the two reviews of the same day.

### What each piece is worth

On every other clip of each set (the clips between were kept for the figures further down),
the first pass's notes alone, with no confidence model (onset F1):

| Step | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| SwiftF0's own segmenter | 0.784 | 0.804 | 0.865 |
| + a note ends at any onset in the spectrum | 0.778 (not used) | 0.834 | 0.880 |
| ... only where the stem's level rises too | 0.787 (not used) | 0.839 | 0.883 |
| + the start moved back to the attack | 0.741 (not used) | 0.840 | 0.946 |

- **Bass starts were 28 ms late on average**, 11 to 49 ms
  depending on the song: the pitch settles after the string is struck. Of the notes found
  within 100 ms of their place, 7.2 percent lay outside the 50 ms a right note is allowed.
  Moving each start to where the level rises fastest leaves 0.6 percent outside, 13 ms
  late on average. On guitar the starts were already right (3.0 percent outside before,
  2.5 after); on a voice the attack is a consonant, not the note, so a voice's starts are
  left alone.
- **Splitting where a note is struck again** finds the repeated notes that pitch alone runs
  together. "Struck" is an onset in the spectrum with a rise of 3 dB in the stem's own level.
  The second half of that was added for bleed (further down), and it is a little better on
  clean stems too. A voice is not split: at any onset it found as many wrong cuts as right
  ones, and with the level test it comes out level with not splitting (0.787 against
  0.784 on 20 clips).
- **The note cost** (SwiftF0's 80 ms) was the best value for all three when it was tried: 3,
  4, 6.5 and 8 frames all scored lower or the same. That, and how far an onset must stand
  out, were settled earlier in the work, before every stem was read at one level.
- **Not tuned to the test:** every setting was chosen on this half of the clips.

### The level a stem is read at

SwiftF0 calls a frame silent under a fixed level, so what it finds depends on how loud the
stem is. Before the level was fixed, three clips of each set were read again at lower peaks
and scored against their own notes at their own level (onset F1):

| Read at a peak of | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| 0.03 | 0.87 to 1.00 | 0.83 to 0.97 | 0.99 to 1.00 |
| 0.01 | 0.73 to 0.94 | 0.62 to 0.90 | 0.95 to 0.99 |
| 0.003 | 0.36 to 0.64 | 0.08 to 0.32 | 0.87 to 0.93 |

So every stem is brought to one level before it is read. Which level, on the same halves as
above (the first pass's notes, onset F1):

| Read at a peak of | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| each clip's own | 0.783 | 0.836 | 0.945 |
| 0.25 | 0.781 | 0.839 | 0.946 |
| **0.35** (the engine's) | 0.784 | 0.840 | 0.946 |
| 0.5 | 0.786 | 0.839 | 0.945 |

It hardly matters on clean recordings, whose own peaks lie near there (medians 0.62, 0.45 and
0.27), and no more with bleed: a bass with its song's other stems turned down 20 dB scored 0.799,
0.800 and 0.799 read at 0.25, 0.35 and 0.5. The peak is the stem's 32nd largest sample, so
one click does not set the level.

### The whole transcriber, through the code a run uses

`scripts/midi_bench.py`, methods `yin` (the tracker "Write MIDI" used until now),
`swiftf0-notes`, `openstems` (exact pitch) and `openstems-midi` (the keys in the MIDI file).
Every clip of each set, the tuned-on half included:

| Stem | Method | Clips | Onset P | Onset R | Onset F1 | +Offset F1 | Octave errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vocals (vocadito) | Old tracker | 40 | 0.372 | 0.422 | 0.392 | 0.240 | 12 |
|  | SwiftF0's segmenter | 40 | 0.876 | 0.706 | 0.778 | 0.646 | 1 |
|  | **This transcriber** | 40 | 0.870 | 0.719 | **0.784** | **0.654** | 1 |
|  | The same as MIDI keys | 40 | 0.812 | 0.672 | 0.733 | 0.614 | 1 |
|  | A second human annotator | 40 | 0.812 | 0.685 | 0.740 | 0.642 | 0 |
| Guitar solos (GuitarSet) | Old tracker | 180 | 0.324 | 0.328 | 0.324 | 0.220 | 798 |
|  | SwiftF0's segmenter | 180 | 0.895 | 0.738 | 0.801 | 0.636 | 15 |
|  | **This transcriber** | 180 | 0.905 | 0.817 | **0.855** | **0.705** | 21 |
|  | The same as MIDI keys | 180 | 0.902 | 0.814 | 0.852 | 0.703 | 21 |
| Bass (Slakh's own stems) | Old tracker | 142 | 0.771 | 0.597 | 0.658 | 0.388 | 1324 |
|  | SwiftF0's segmenter | 142 | 0.888 | 0.806 | 0.838 | 0.723 | 8 |
|  | **This transcriber** | 142 | 0.963 | 0.920 | **0.937** | **0.823** | 76 |
|  | The same as MIDI keys | 142 | 0.963 | 0.920 | 0.937 | 0.823 | 76 |

On the half of the clips nothing was fitted on (`scripts/midi_calibrate.py report`): vocals
0.775, guitar solos 0.854, bass 0.927.

- **Part of what is left is not the transcriber's to find.** A single-line reader finds one
  note at a time, and the references hold more: 20 percent of GuitarSet's "solo" notes
  start while another sounds (double stops), 12 percent of Slakh's bass notes (two bass
  parts, or one doubled). Recall on notes that sound alone is 0.87 on guitar and
  0.94 on bass, against 0.51 and 0.46 on the ones that overlap.
- **Two Slakh songs were scored wrong until now.** The bass of Track01931 and Track01937
  sounds 14 semitones under its MIDI, not 12; scored an octave down, every one of their
  notes counted as two semitones off. The scorer now reads them as they sound
  (`SOUNDS_AT_SONG`).
- **Vocals as MIDI keys score lower than at exact pitch** (0.733 against 0.784), as section
  7 found: singers sit between the keys, and the window is 50 cents.

### With the rest of a song left in the stem: a stand-in for separation

A separated stem is not a clean one. Scoring real separated stems needs the GPU, so this is
the nearest thing the CPU allows: each clip with the rest of a song under it, 25 dB and 15 dB
down (RMS against the stem's). A bass gets its own song's other stems, in time with it. The
voice and guitar clips come alone, so each gets a Slakh song's whole mix. On the held-out
clips, what is shown (onset F1, with precision and recall):

| Read | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| alone | 0.775 (0.868, 0.706) | 0.854 (0.905, 0.816) | 0.927 (0.956, 0.907) |
| with the rest 25 dB under it | 0.771 (0.864, 0.702) | 0.853 (0.909, 0.811) | 0.920 (0.957, 0.895) |
| with the rest 15 dB under it | 0.743 (0.821, 0.685) | 0.833 (0.896, 0.786) | 0.881 (0.918, 0.858) |

Two things in the transcriber are there because of this measurement:

- **A note ends where it is struck again only if the stem's level rises there.** A drum that
  bled into a bass stem makes an onset in the spectrum with every hit, and under a held note
  it barely moves the level. Ending notes at any onset, 6 in 10 of a bleeding bass's wrong
  notes were pieces cut out of held notes. The first pass's notes, development half:

  | | Guitar solos, 25 dB | 15 dB | Bass, 25 dB | 15 dB |
  | --- | --- | --- | --- | --- |
  | a note ends at any onset | 0.821 | 0.787 | 0.812 | 0.722 |
  | only where the level rises too | 0.824 | 0.793 | 0.848 | 0.766 |

- **The confidence model is fitted on all three readings,** not on clean stems alone.
  Fitted on clean stems, it took a quiet note between a bass's own notes for a note, which
  with bleed it is not. On the held-out clips (onset F1 of what is shown):

  | Fitted on | Vocals, 25 dB | 15 dB | Guitar solos, 25 dB | 15 dB | Bass, 25 dB | 15 dB |
  | --- | --- | --- | --- | --- | --- | --- |
  | clean stems | 0.767 | 0.725 | 0.852 | 0.830 | 0.900 | 0.844 |
  | all three readings | 0.771 | 0.743 | 0.853 | 0.832 | 0.920 | 0.881 |

  Read alone, the two fits score the same: 0.774 and 0.775 on vocals, 0.854 and 0.854 on guitar,
  0.928 and 0.927 on bass.

What it does not say:

- **It is a stand-in.** What a separator leaves in a stem is what it could not tell apart
  from it, not an even share of everything else, and it adds faults of its own that this
  has none of. The figures say the transcriber no longer falls apart with other sound under
  the stem; they do not say what it scores on separated stems.
- **Where real stems lie.** How sure SwiftF0 is of a pitch falls as bleed rises: over the
  held-out bass stems it averages 0.962 alone, 0.934 at 25 dB and 0.831 at 15 dB. The two
  separated bass stems among the project's test songs read 0.94 and 0.95, so those lie
  between the clean stems and the 25 dB reading. Two stems are not much to go by.
- **The chords mark errs with heavy bleed.** 69 of 71 held-out bass stems still read as a line at
  25 dB, 50 at 15 dB: under that much bleed a bass is called chords.

### Low bass

Slakh has no bass note under SwiftF0's 46.9 Hz floor, so `--sets slakh-low` plays its bass
stems 7 semitones lower, as a slowed tape would, with the reference moved the same way: the
lowest note becomes a D1 at 36.7 Hz, and 23 percent of the notes lie under the floor. A
slowed bass is harder than a real low one (every error in time stretches by half as well),
so these figures are read against each other, not against the table above.

| Method | Songs | Onset P | Onset R | Onset F1 | +Offset F1 |
| --- | --- | --- | --- | --- | --- |
| Old tracker | 60 | 0.786 | 0.674 | 0.710 | 0.448 |
| SwiftF0's segmenter | 60 | 0.693 | 0.514 | 0.580 | 0.512 |
| **This transcriber** | 60 | 0.800 | 0.769 | **0.781** | **0.678** |

Of the 6,437 notes under the floor, SwiftF0's segmenter finds 9 percent and the
transcriber, with its second pass at double speed, 82 percent; at or above the floor
they find 56 and 68 percent.

On steady test tones the picture is cleaner: SwiftF0 calls a tone at 43.7 Hz or below
unvoiced (under 2 percent of frames voiced, for tones from 30.9 to 43.7 Hz), and at double
speed it follows every one of them within a cent or two, down to 30.9 Hz, a 5-string's low
B, with the fundamental at full level or 16 dB down.

### How far the confidence can be trusted

Each note's confidence comes from a logistic model fitted on one half of the clips, each
read alone and with bleed. On the other half, read alone:

| | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| Notes found, candidates included | 864 | 8,245 | 32,816 |
| Ranks a right note above a wrong one (AUC) | 0.698 | 0.869 | 0.788 |
| F1 showing notes by confidence | 0.775 | 0.854 | 0.927 |
| F1 of the segmenter's own choice | 0.771 | 0.837 | 0.926 |

What a confidence means, on the held-out clips (share of notes that were right, and how many
notes there were):

| Confidence said | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| 0.9 to 1.0 | 0.93 (352) | 0.95 (5,318) | 0.97 (30,635) |
| 0.8 to 0.9 | 0.85 (327) | 0.86 (1,159) | 0.80 (955) |
| 0.7 to 0.8 | 0.84 (87) | 0.78 (436) | 0.77 (318) |
| 0.5 to 0.7 | 0.76 (58) | 0.63 (456) | 0.55 (312) |
| under 0.5 | 0.33 (40) | 0.20 (876) | 0.26 (596) |

- **At the top it means what it says.** Of the notes it calls 0.9 or more, 93 to
  97 in 100 are right (the table's first row).
- **For the editor's sensitivity control it works:** on guitar, moving the line from 0.2 to
  0.9 takes precision from 0.88 to 0.95 and recall from 0.83 to 0.62.
- **For a "check these notes" list it is only part of the answer.** Marking the shown notes
  under 0.8 marks 13 percent of a guitar line and catches 43 percent of its wrong notes;
  about 32 in 100 of the marked notes are wrong. On a voice it marks 20 percent and catches
  35 percent; on bass 2 percent and 14 percent.
  - So a "check these notes" bar in the editor cannot be the way to a correct file by
    itself. The marks are worth showing; a view of what differs from the audio and the
    sensitivity control have to carry the rest.
- **A voice's confidence ranks weakly** because what counts as wrong there is mostly how a
  phrase is written down: a note a key or two from the reference's, or one cut where the
  annotator held it (the tables below). The second annotator disagrees with the first about
  as often (0.740).
- The model will be fitted again on separated stems. `scripts/midi_calibrate.py fit` prints
  the numbers to paste.

### What the wrong notes are

The shown notes of the held-out clips that mir_eval does not pair with a reference note, and
the reference notes it pairs with nothing, by what lies there instead (percent of each
column; the first row that fits):

| A wrong note is | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| *(wrong, of the notes shown)* | *13.1* | *9.7* | *4.1* |
| The right pitch, cut out of a longer note | 29 | 39 | 38 |
| The right pitch, its start over 50 ms off | 3 | 4 | 29 |
| One or two keys from a note that starts there | 53 | 16 | 15 |
| An octave or two from it | 1 | 3 | 2 |
| Another pitch, same start | 0 | 10 | 7 |
| While a note of another pitch sounds | 10 | 16 | 6 |
| Where the reference has nothing | 5 | 12 | 4 |

| A missed note is | Vocals | Guitar solos | Bass |
| --- | --- | --- | --- |
| *(missed, of the reference's notes)* | *31.4* | *20.6* | *12.8* |
| Run into the note before it, of the same pitch | 38 | 23 | 21 |
| Found, its start over 50 ms off | 10 | 16 | 28 |
| Found at another pitch | 32 | 24 | 29 |
| Starts while another note sounds | 0 | 19 | 10 |
| Under a found note of another pitch | 15 | 13 | 2 |
| Nothing found there | 5 | 6 | 11 |

- **Where one note ends and the next begins is the largest part of it.** 29, 39 and 38
  percent of the wrong notes are a piece cut out of a longer note, and 38, 23 and 21 percent
  of the missed ones were run into the note before them. Split and join are the edits an
  editor needs first.
- **A voice's wrong notes are otherwise a key or two off:** 53 percent of them start where
  a reference note does, one or two keys from it. Scoops and ornaments: the two annotators
  write those down differently as well.
- **Octave mistakes are rare:** 1, 3 and 2 percent of the wrong notes are an octave or two
  off. So the notes file holds no second guess at a note's pitch: SwiftF0 gives one pitch
  per frame, the frames hold no evidence for another, and a "which octave?" question would
  nearly always be asked of a right note.
- **What an editor's questions can use is in the file:** the exact pitch and the tuning (a
  note between two keys), the confidence, and the candidates.

### Other measurements

- **Chords or a line.** How sure SwiftF0 is of one pitch over a stem's louder frames tells
  GuitarSet's 180 chord clips from its 180 solos 99 times in 100 (AUC 0.988). At the line the
  engine draws (0.80, chosen on these clips), 95 percent of the solos and 95 percent of the
  chord clips are named rightly; every vocal clip and 141 of 142 bass stems read as a line.
  - The louder frames are counted among those within 20 dB of the stem's tenth loudest
    frame. Counted over all frames, as at first, a line that sounds a quarter of the time
    read as chords: 0 of 18 solos followed by three times their length of hiss 70 dB down
    were called a line. Now 18 of 18 are, and as many with chords 20 dB down in the gap.
- **Tuning.** Slakh's bass played 35 cents sharp (20 songs) is read as 39 cents sharp with a
  strength of 0.97. Its MIDI keys, against the notes that were meant: 0.928 rounded at A440,
  0.952 rounded in the song's own tuning, which is what the engine does when a stem with
  fixed pitches is that sure. A voice never sets the tuning: singers drift.
- **Velocity.** A note's level says something of how hard it was played, and not much: on
  27 Slakh bass stems the two agree in rank at 0.42 (Spearman), and the velocity-aware score
  is 0.60 with it against 0.51 with every velocity the same (the notes alone score 0.92).
- **Time.** A stem of 6 minutes 26 seconds takes 2.1 s as a bass and 1.7 s as a voice, on
  two CPU threads.
- **Pure sines.** SwiftF0 was trained on voices and instruments, which have harmonics, and
  a pure sine has none. Ten notes from E1 to E4 as steady pure sines, read as a bass: 9 are
  shown (not the E1, at 41 Hz). The same notes dying away as an 808's do: 6. With a second
  harmonic 30 dB under the sine: all 10. So a clean sub-bass or a clean 808 may lose notes;
  a bass with any grit does not.
  - Two remedies were tried and neither is in the engine yet. A little even-harmonic
    distortion in front of the pitch tracker read the dying sines, and cost real recordings
    (guitar solos 0.840 to 0.835, bass 0.946 to 0.945, the first pass on the development
    half). A second look does better: the tracker run again on the distorted stem, its
    frames taken only where the first look heard no pitch. That shows 9 of the 10 dying
    sines and all 10 steady ones, and leaves real recordings as they were (0.784, 0.840 and
    0.945 against 0.784, 0.840 and 0.946), with bleed too (a bass with the rest of its song
    25 dB under it: 0.941 shown either way). It reads a pure low B, under SwiftF0's floor,
    as the B above, and it doubles the tracker's work. It wants real 808s and clean
    sub-basses before it goes in.

### Not measured

- **Separated stems.** Phase 7's acceptance is on separated stems, and that run needs the
  GPU. The stand-in above is not it. The thresholds, the weights and the level a stem is
  read at all wait for the real thing.
  - The transcriber was run on the separated stems of the project's three test songs, to
    see that it behaves; there is no reference to score them against. The stems the app
    calls empty hold no notes. The basses give lines in a bass's range, one of them from a
    stem that peaks at 0.09. The guitar and "other" stems mostly read as chords. One piano
    stem that is only bleed, 41 dB under its song's loudest stem and so not empty, gives one
    stray note: read at full level, bleed can.
- **Melodyne on the same clips with this transcriber.** The pack's comparison in section 7
  used SwiftF0's segmenter; the new exports the owner was asked for are not in yet.
- **A real low bass.** The low set is a slowed one.
- **Real songs' tuning.** The tuning check used a synthetic detune.

## Sources

Primary unless marked. Figures are *reported* unless the source was re-read for this document.

- YourMT3+: https://arxiv.org/abs/2407.04822; code https://github.com/mimbres/YourMT3 (GPL-3.0,
  checked through the GitHub API); weights https://huggingface.co/mimbres/YourMT3 (model card
  license Apache-2.0, checked; five Lightning `.ckpt` files)
- 2025 AMT Challenge: https://arxiv.org/abs/2603.27528
- Transkun: https://github.com/Yujia-Yan/Transkun
- Basic Pitch: https://arxiv.org/pdf/2203.09893, https://github.com/spotify/basic-pitch. PyPI
  0.4.0 classifiers list Python 3.8 to 3.11, and on Windows with Python 3.11 or later it
  requires `tensorflow<2.15.1` (checked through the PyPI API)
- ADTOF: https://github.com/MZehren/ADTOF; port https://github.com/xavriley/ADTOF-pytorch
- Drum separation and transcription: https://arxiv.org/abs/2509.24853
- Mel-RoFormer transcription: https://arxiv.org/abs/2409.04702
- Jointist: https://arxiv.org/abs/2302.00286
- Lyrics on separated vocals: https://arxiv.org/abs/2506.02339
- Speech enhancement artifacts: https://arxiv.org/abs/2201.06685
- Timbre-Trap: https://arxiv.org/html/2309.15717v2
- Differentiable rendering for transcription: https://boblsturm.github.io/aimusic2020/papers/CSMC__MuMe_2020_paper_31.pdf
- Sinusoidal frequency by gradient descent: https://arxiv.org/pdf/2210.14476v2
- FCPE and pitch tracker comparison: https://arxiv.org/html/2509.15140v1
- HMM note segmentation: https://arxiv.org/pdf/1704.08729
- Celemony patent US 8,022,286: https://patents.google.com/patent/US8022286
- Celemony manuals: MIDI export, modulation and drift, Note Assignment mode (links in section 1)
- Sound On Sound, Melodyne DNA review (secondary, 2009)
- MPE RP-053: https://midimpe.neocities.org/rp53spec.pdf
- mir_eval transcription metrics: https://mir-eval.readthedocs.io/latest/api/transcription.html
- Datasets: MAESTRO, E-GMD (Magenta pages), Slakh2100 (slakh.com), GuitarSet and MusicNet
  (Zenodo), MIMuT data card (secondary)
- Songscription benchmark (vendor blog), Futureproof roundup (blog), Arranger For Hire (blog),
  informal stems test (JDeun/audio-score-tool PR 195, not peer reviewed)
- License sweep, read 2026-11-23:
  - Pitch trackers: github.com/lars76/swift-f0 and arXiv 2508.18440; github.com/maxrmorrison/torchcrepe;
    github.com/CNChTu/FCPE and huggingface.co/ChiTu/FCPE; github.com/Dream-High/RMVPE and
    huggingface.co/lj1995/VoiceConversionWebUI; github.com/SonyCSLParis/pesto.
  - Vocal note models: github.com/openvpi/SOME (releases); github.com/RickyL-2000/ROSVOT;
    github.com/c4dm/pyin; github.com/ronggong/pypYIN.
  - Drums: magenta onsets_frames_transcription README; arXiv 2509.21739 (Noise-to-Notes);
    arXiv 2608.01093 (Separate-and-Detect); arXiv 2601.09520 (ADT_STR);
    github.com/polimi-ispl/larsnet; StemGMD, zenodo.org/records/7860223.
  - Polyphonic models: github.com/gudgud96/basic-pitch-torch; Zenodo 4034264 (Kong) and
    10610212 (Edwards); github.com/EleutherAI/aria-amt; huggingface.co/MuScriptor/muscriptor-large;
    github.com/gudgud96/MR-MT3 and huggingface.co/gudgud1014/MR-MT3; github.com/kunato/mt3-pytorch;
    arXiv 2408.08653 (GAPS); huggingface.co/danmor/guitab; github.com/ImSe4n/PTify.
  - Third-party cross-evaluation: arXiv 2609.04640 (Harmonica).
- DAW import: Image-Line manual and forum (links in section 8); Ableton Live 12 manual; Logic Pro
  13.0 release notes; Bitwig 3.2.8 release notes; Steinberg Cubase 15 help; Cockos wiki.
  Patent status from Google Patents (US8022286B2, EP2099024B1), secondary.
