"""Request and response models of the local API. They define the OpenAPI schema that
the TypeScript client in ``app/`` is generated from."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

JobStateName = Literal["queued", "preparing", "running", "writing", "done", "failed", "cancelled"]
Quality = Literal["fast", "balanced", "best"]
OutputFormat = Literal["wav32f", "wav24", "flac", "mp3"]
Fit = Literal["fits", "tight", "no"]
_DOWNBEAT = "Where bar 1 starts, in seconds, in place of the detected one."
_PART = (
    "The part of the song these stems are, when only a part of it was separated: their "
    "timeline starts at the part's start, not at the song's. Null for the whole song."
)


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    version: str
    fake_engine: bool


class WorkerStatus(BaseModel):
    alive: bool
    ready: bool
    pid: int | None = None
    restarts: int = 0
    current_job: str | None = None


class SystemInfo(BaseModel):
    version: str
    python: str
    torch: str | None = None
    # The names are older than AMD and Mac support. `cuda_available` means "a GPU works",
    # whichever backend it is; on a Mac (`mps`) `vram_gb` is the machine's unified memory.
    cuda_available: bool = False
    cuda_version: str | None = None
    gpu_backend: Literal["cuda", "rocm", "mps"] | None = None
    gpu_backend_version: str | None = None
    gpu_name: str | None = None
    vram_gb: float | None = None
    # What one model run may use on this machine, and the memory it is cut from: the card's
    # on a PC, the machine's on a Mac or on the CPU. Null when the machine does not say.
    memory_gb: float | None = None
    memory_budget_gb: float | None = None
    # Where models run as the settings stand, which decides the budget's rule: a graphics
    # card ("cuda", NVIDIA or AMD), the Apple GPU ("mps") or the CPU.
    memory_kind: Literal["cuda", "mps", "cpu"] = "cpu"
    memory_overridden: bool = Field(
        default=False, description="OPENSTEMS_MEMORY_GB stands in for the detected memory."
    )
    ffmpeg: str | None = None
    ffmpeg_decode_ok: bool = False
    problems: list[str] = []
    notes: list[str] = []
    fake_engine: bool = False
    worker: WorkerStatus
    config_dir: str
    logs_dir: str
    chord_model: bool = Field(
        default=False,
        description="Whether the model that reads chords for stem to MIDI is installed.",
    )


class TrackInfo(BaseModel):
    path: str
    name: str
    ok: bool = True
    error: str | None = None
    duration: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    codec: str = ""
    container: str = ""
    bytes: int = 0


class RegisterTracks(BaseModel):
    paths: list[str] = Field(description="Files or folders. Folders expand to their media files.")


class TrackList(BaseModel):
    tracks: list[TrackInfo]


class RecipePass(BaseModel):
    id: str
    models: list[str]
    input: str


class RecipeInfo(BaseModel):
    id: str
    name: str
    use_case: str
    description: str
    version: int
    builtin: bool
    experimental: bool
    selectable_outputs: bool
    single_model: bool = False
    outputs: list[str]
    output_groups: dict[str, str] = Field(
        default_factory=dict,
        description="The group of each output stem that is a part of a larger one, such as "
        "kick in drums. The parts of a group add up to it; the group is not written.",
    )
    models: list[str]
    passes: list[RecipePass]
    missing_models: list[str]
    download_bytes: int = 0
    supports_sum_to_mix: bool
    fit: Fit = Field(
        default="fits",
        description="Whether the recipe's largest model fits this machine. Models run one "
        "at a time, so a recipe is as large as its largest model.",
    )
    fit_model: str | None = Field(default=None, description="The model that decides the fit.")
    memory_gb: float = Field(default=0.0, description="What that model needs, in GB.")


class RecipeList(BaseModel):
    recipes: list[RecipeInfo]


class DownloadState(BaseModel):
    state: Literal["downloading", "verifying", "installed", "failed", "cancelled"]
    done: int
    total: int
    error: str | None = None


class ModelInfo(BaseModel):
    id: str
    name: str
    architecture: str
    loader: str
    license: str
    stems: list[str]
    use_cases: list[str]
    bytes: int
    status: Literal["installed", "unverified", "partial", "missing"]
    seed: bool
    experimental: bool
    custom: bool
    notes: str
    used_by: list[str] = []
    download: DownloadState | None = None
    memory_gb: float = Field(
        default=0.0, description="What one run needs on this machine at batch 1, in GB."
    )
    memory_estimated: bool = Field(
        default=False, description="The figure was not measured the way this machine runs."
    )
    fit: Fit = Field(
        default="fits",
        description="Against the machine's memory budget. 'tight': it fits with less than "
        "15 percent to spare. 'no' is advice: the model may still be run.",
    )
    recommended: bool = Field(
        default=False, description="Part of the set offered for the first download here."
    )


class ModelList(BaseModel):
    models: list[ModelInfo]
    models_dir: str
    installed_bytes: int


class VerifyResult(BaseModel):
    id: str
    ok: bool
    problems: list[str]


class ImportModel(BaseModel):
    checkpoint: str
    config: str
    architecture: Literal["bs_roformer", "mel_band_roformer", "mdx23c"]
    id: str | None = None
    name: str | None = None
    acknowledge_pickle_risk: bool = Field(
        default=False, description="Must be true: checkpoints are pickles."
    )


class JobRange(BaseModel):
    """A part of a song, chosen in the trimmer while the song waits in the queue. With the
    separate_selection setting on when the song runs, only that part is separated, as a
    song of its own named "<song> (<label>)"."""

    start: float = Field(description="Where the part starts, in seconds into the song.")
    end: float = Field(description="Where it ends, in seconds into the song.")
    label: str = Field(
        description='The part named as a clip of it is: "bars 9-16", "9.3-11.2" or '
        '"0m21.40s-0m33.10s". Named again whenever the tempo or bar 1 of the job changes.'
    )


class JobOptions(BaseModel):
    sum_to_mix: bool | None = None
    output_format: OutputFormat | None = None
    match_source_rate: bool | None = None
    outputs: list[str] | None = Field(default=None, description="Subset of output stems.")
    trim_silence: bool | None = None
    normalize: bool | None = None
    midi_stems: list[str] | None = None
    force: bool | None = None
    bpm: float | None = Field(
        default=None, description="The song's tempo, in place of the detected one."
    )
    key: str | None = Field(
        default=None, description="The song's key, such as Am, in place of the detected one."
    )
    downbeat: float | None = Field(default=None, description=_DOWNBEAT)
    name: str | None = Field(
        default=None,
        description="The song's name, in place of its file's: its stem folder and stems "
        "are named by it. Left out, a song the user named before keeps that name.",
    )
    range: JobRange | None = Field(
        default=None,
        description="The part of the song to separate alone. Set with "
        "POST /v1/jobs/{job_id}/range once the song is in the queue: refused when a job "
        "is created. Separated alone only when the separate_selection setting is on when "
        "the song runs; otherwise the whole song is.",
    )


class CreateJob(BaseModel):
    path: str
    recipe: str | None = Field(default=None, description="Recipe id.")
    model: str | None = Field(default=None, description="Run a single model instead.")
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class CreateBatch(BaseModel):
    paths: list[str]
    recipe: str | None = None
    model: str | None = None
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class CreateLink(BaseModel):
    url: str = Field(description="The web address of a song's page, or of a media file.")
    recipe: str | None = None
    model: str | None = None
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Once fetched: start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class LinkInfo(BaseModel):
    """A song on its way from a link to the queue. It becomes a job once it is fetched."""

    id: str
    url: str
    name: str = Field(description="The song's title once known; the site's name before.")
    state: Literal["waiting", "resolving", "downloading", "failed"]
    progress: float
    error: str | None = None
    created_at: float


class LinkList(BaseModel):
    links: list[LinkInfo]


class CreateMix(BaseModel):
    paths: list[str] = Field(description="Two or more stem files of one song.")


class FindNotes(BaseModel):
    paths: list[str] = Field(
        description="Stem files of one song to find notes in: voices, basses and other "
        "pitched stems. Drums and mixtures are refused."
    )


class MixInfo(BaseModel):
    path: str
    name: str
    label: str
    stems: list[str]
    samples: int
    sample_rate: int


class ClipGrid(BaseModel):
    """The beat grid a selection was made on. It names the clip ("bars 9-16"), and its
    tempo is the one a tempo-synced clip is marked with. Taken as it is, not rounded."""

    bpm: float = Field(description="20 to 999.")
    downbeat: float = Field(
        description="Where bar 1 starts, in seconds from the start of the song. "
        "Negative when it starts before the file does."
    )
    beats_per_bar: int = Field(default=4, description="1 to 16.")


class CreateClips(BaseModel):
    paths: list[str] = Field(
        description="One or more stem files of one song, or the song's own file alone."
    )
    start: float = Field(description="Where the clip starts, in seconds into the song.")
    end: float = Field(description="Where it ends. Kept inside the song.")
    together: bool = Field(
        default=True,
        description="Several stems as one file, their sum. False: one file per stem.",
    )
    grid: ClipGrid | None = Field(
        default=None, description="Without a grid the clip is named by its times."
    )
    source: bool | None = Field(
        default=None,
        description="Whether the one path is the song's own file rather than a stem. "
        "Left out: it is when it is the file of a song in the queue or the history. "
        "A stem that was itself separated is both, so say which.",
    )


class JobRangeRequest(BaseModel):
    """A part of a song as the trimmer chose it, to separate alone."""

    start: float = Field(description="Where the part starts, in seconds into the song.")
    end: float = Field(description="Where it ends. Kept inside the song.")
    grid: ClipGrid | None = Field(
        default=None,
        description="The grid the part was chosen on, which names it. A job with no "
        "tempo of its own keeps the grid's tempo and bar 1 (bar 1 alone when it has that "
        "tempo), so its run lays the bars out where the name says. Left out: the tempo "
        "and bar 1 the job was given, when it has both; else the part is named by its "
        "times.",
    )


class SetJobRange(BaseModel):
    """The part of a waiting song to separate alone: {"range": {"start", "end", "grid"}}
    sets it, {"range": null} takes it away again. Its label is decided when it is set, and
    again whenever the job's tempo or bar 1 changes."""

    range: JobRangeRequest | None = Field(
        description="The part, or null to separate the whole song.",
    )


class ClipInfo(BaseModel):
    path: str
    name: str
    label: str = Field(description="The stem or mix in the clip's name; empty for the song.")
    stems: list[str] = Field(description="The stems in the clip; none for the song.")
    start: float = Field(description="Where the clip starts in the song, in seconds.")
    end: float
    samples: int
    sample_rate: int


class ClipList(BaseModel):
    clips: list[ClipInfo]


class SourcePreviewRequest(BaseModel):
    path: str = Field(description="The file of a song in the queue or the history.")


class SourceAnalysis(BaseModel):
    bpm: float | None = None
    key: str | None = None
    downbeat: float | None = Field(
        default=None, description="Where bar 1 starts, in seconds into the song."
    )


class SourcePreview(BaseModel):
    """A song's own file as the app plays and draws it before separation."""

    audio: str = Field(description="A 16-bit FLAC at 44.1 kHz, served by /v1/files.")
    peaks: str = Field(description="Its peaks, served by /v1/peaks.")
    duration: float
    sample_rate: int
    analysis: SourceAnalysis = Field(description="What detection finds in the file.")


class StemFile(BaseModel):
    name: str
    file: str
    path: str
    peaks: str | None = None
    midi: str | None = Field(
        default=None, description="The stem's MIDI file, when it was read and held notes."
    )
    notes: str | None = Field(
        default=None,
        description="The stem's notes file (`<stem>.notes.json`), when it was read: every "
        "note found with its confidence, and the confidence at which a note counts. A stem "
        "with this and no `midi` was read and held no notes.",
    )
    samples: int | None = None
    sample_rate: int | None = None
    group: str | None = Field(
        default=None, description="The larger stem this one is a part of, if any."
    )
    start: float = Field(
        default=0.0,
        description="Seconds into the song where this file begins: later than 0 when its "
        "leading silence was trimmed.",
    )
    empty: bool = Field(
        default=False,
        description="Nothing but what the model let through: its peak stays more than "
        "45 dB under the loudest stem of the set. The file is written all the same. The "
        "app leaves such stems out of its lists while the hide_empty_stems setting is on.",
    )
    hidden: bool | None = Field(
        default=None,
        description="The user's own choice for the app's lists: true leaves the stem out "
        "of them whatever the setting, false keeps it in though it is empty, null leaves "
        "it to `empty` and the setting. The file is there either way.",
    )


class JobInfo(BaseModel):
    id: str
    track_path: str
    track_name: str = Field(
        description="The song's name: the one the user gave it, or else its file's."
    )
    recipe_id: str
    recipe_name: str
    quality: str
    state: JobStateName
    progress: float
    message: str
    error: str | None = None
    cached: bool
    output_dir: str | None = None
    options: dict[str, Any] = {}
    stems: list[StemFile] = []
    analysis: dict[str, Any] = {}
    notes: list[str] = Field(
        default=[],
        description="What did not go as planned, such as a model that ran on the CPU.",
    )
    queue_position: int | None = None
    held: bool = Field(default=False, description="Queued, and waiting for the user's Start.")
    part: JobRange | None = Field(default=None, description=_PART)
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None


class JobList(BaseModel):
    jobs: list[JobInfo]


class Reorder(BaseModel):
    ids: list[str] = Field(description="Every queued job id, in the new order.")


class Removed(BaseModel):
    removed: int


class SettingsModel(BaseModel):
    models_dir: str
    output_dir: str
    cache_dir: str
    output_format: OutputFormat
    match_source_rate: bool
    naming_template: str
    default_recipe: str
    default_quality: Quality
    sum_to_mix: bool
    trim_silence: bool
    normalize: bool
    detect_tempo_key: bool
    tempo_sync: bool
    write_midi: bool
    watch_folder: str
    watch_enabled: bool
    vram_budget_gb: float
    use_gpu: bool
    auto_start: bool
    separate_selection: bool
    hide_empty_stems: bool


class SettingsPatch(BaseModel):
    models_dir: str | None = None
    output_dir: str | None = None
    cache_dir: str | None = None
    output_format: OutputFormat | None = None
    match_source_rate: bool | None = None
    naming_template: str | None = None
    default_recipe: str | None = None
    default_quality: Quality | None = None
    sum_to_mix: bool | None = None
    trim_silence: bool | None = None
    normalize: bool | None = None
    detect_tempo_key: bool | None = None
    tempo_sync: bool | None = None
    write_midi: bool | None = None
    watch_folder: str | None = None
    watch_enabled: bool | None = None
    vram_budget_gb: float | None = None
    use_gpu: bool | None = None
    auto_start: bool | None = None
    separate_selection: bool | None = None
    hide_empty_stems: bool | None = None


class SetAnalysis(BaseModel):
    """The tempo, key and bar 1 the user gives a song. A field left out is not changed;
    null means the song has none (for a job that has not run yet: detect it)."""

    bpm: float | None = None
    key: str | None = None
    downbeat: float | None = Field(default=None, description=_DOWNBEAT)


class SetStemSetAnalysis(SetAnalysis):
    directory: str


class SetHidden(BaseModel):
    """The stems of one stem set the user hides from the app's lists, or keeps in them."""

    directory: str
    stems: dict[str, bool | None] = Field(
        description="Stem name to the choice: true hides it, false keeps it in though it "
        "is empty, null takes the choice away. Stems not named stay as they are."
    )


class SetName(BaseModel):
    """The name the user gives a song. null gives it its file's name back."""

    name: str | None = Field(
        description="Up to 120 characters. Characters a file name cannot hold are kept in "
        "the name and replaced where it names a folder or a file."
    )


class SetStemSetName(SetName):
    directory: str


class StemSetInfo(BaseModel):
    directory: str
    track_name: str
    track_path: str
    track_hash: str
    recipe_id: str
    recipe_name: str
    created_at: str
    analysis: dict[str, Any] = {}
    stems: list[StemFile]
    source_exists: bool = True
    part: JobRange | None = Field(default=None, description=_PART)


class StemSetList(BaseModel):
    stem_sets: list[StemSetInfo]


class Rebuilt(BaseModel):
    stem_sets: int


class Peaks(BaseModel):
    version: int
    sample_rate: int
    samples: int
    samples_per_peak: int
    length: int
    peak: float = 0.0
    data: list[float]


class Diagnostics(BaseModel):
    path: str


class ChordModel(BaseModel):
    """The model that reads chords for stem to MIDI (Basic Pitch, 230 KB)."""

    installed: bool


class SelfTestOp(BaseModel):
    name: str
    ok: bool
    error: float | None = None
    detail: str = ""


class SelfTestModel(BaseModel):
    id: str
    ok: bool
    difference_db: float | None = None
    half_precision_db: float | None = None
    gpu_seconds: float | None = None
    cpu_seconds: float | None = None
    detail: str = ""


class SelfTest(BaseModel):
    """GPU against CPU: single operations, then one short separation per architecture."""

    ok: bool
    torch: str | None = None
    gpu_backend: Literal["cuda", "rocm", "mps"] | None = None
    gpu_backend_version: str | None = None
    gpu_name: str | None = None
    gpu_available: bool = False
    ops: list[SelfTestOp] = []
    models: list[SelfTestModel] = []
    problems: list[str] = []
    notes: list[str] = []


class ErrorBody(BaseModel):
    detail: str
