# Kinetic Typography Composer

A browser-based composer for beat-driven kinetic typography, built around the
classical 起承轉合 dramatic structure.

Plain HTML + vanilla ES modules + Tailwind (play CDN). No build step.
Glyph outlines come from **opentype.js 1.3.4**; every effect runs in
**three.js 0.170**; beat analysis runs in a Web Worker.

---

## Status

Everything below is implemented and working in the browser. There is no build
step; the editor uses the two display/geometry CDN libraries above, and loads
the optional speech runtime/model only when VO analysis is requested.

| Area | State |
|---|---|
| 起承轉合 reference lines | two levels (overall + animation), merged 起承 handle, ratio scaling, multi-select runs, non-destructive pair insertion |
| Text layers | 3 tracks, unlimited simultaneous clips, 20 effects, per-clip typeface / weight, 3D position, parent/child offsets, beat reaction, and colour keyframes |
| Camera | keyframed 3D position / roll with easing, on its own track |
| Backdrop colour | solid, linear / circular / 4-point gradients with colour keyframes |
| Audio | 3 lanes (BGM · VO · SFX), each slippable, with level, mute, and optional VO word timing |
| Backdrop video | 3 visual channels, each holding multiple clips with independent timing, opacity / fit / loop / mask / In-Out fades |
| Beat analysis | STFT → spectral flux → adaptive peaks → autocorrelation tempo → phase-locked grid |
| Peaks | transient detection with spacing and sensitivity thresholds, snappable |
| Metronome | synthesised click bus, 3 voices, track-follow or manual BPM with tap tempo |
| Typography | 3-slot fallback stack, browser-measured kerning, CJK-correct counters |
| Export | real-time MP4 capture (WebM fallback), `.ktc.json` project save/load |

**Measured accuracy.** Tempo detection was checked against synthetic click
tracks at 90 / 120 / 140 BPM and returned 89.97 / 120.07 / 140.01 BPM with the
downbeat phase correct to within a frame. On a 120 BPM import the app read
120.1 BPM and *Fit to music* landed every reference line on a bar.

**Known limits.**

- Recording is real time — a 60 s piece takes 60 s to capture. There is no
  offline frame-by-frame render.
- Audio and backdrop settings are retained in a saved project, but their source
  files are referenced by name rather than embedded, so sources must be
  re-imported after opening a file.
- The timeline collapses unused audio and backdrop video lanes: it is about 258 px
  with neither loaded and grows to ~428 px when every media lane is visible;
  on a short screen the stage viewport gets tight.
- BGM is one analysed source; VO and SFX lanes can contain multiple independent clips.
- VO word timing is model-based and approximate; review the waveform and adjust
  the text clip edges when a word is misrecognised or a pause is ambiguous.
- Backdrop videos are visual-only and muted; video sound must be imported to an audio lane.

---

## Run it

The app uses ES modules and a Web Worker, so it needs to be served over HTTP
(opening `index.html` from the filesystem will not work).

```bash
python3 serve.py 5178
```

Then open <http://localhost:5178>. Any static server works; `serve.py` just adds
no-cache headers and the right MIME types for local development.

---

## The model

Six independent things live in a composition: the **reference lines** that give
it shape, the **layers** that render, the **camera** that frames them, the
**backdrop colour** and **backdrop video** behind them, and the **audio** they
are cut against. Reference lines, camera, backdrops, and audio remain
independent; text layers may optionally parent other text layers.

### 起承轉合 — reference lines, at two levels

These are **guides**, not containers. They work like a grid on a canvas: they
mark the shape of the piece and everything snaps to them, but nothing renders
from them and no content lives inside them.

The structure exists at two scales, each with its own row on the timeline:

| Level | Span | Typical use |
|---|---|---|
| **整體 Overall** | always the whole video | the macro arc — usually 1 承轉 pair, kept simple |
| **動態 Animation** | its own span, dragged with brackets | the finer beat the animations move to — 3 pairs by default |

The animation arc snaps to the overall arc, layers snap to both, and a new
layer takes its default effect from the *finer* level covering it.

| Guide | Role | Behaviour |
|---|---|---|
| 起 Qǐ | open | a short strike — the start point, capped at ~1.2 s |
| 承 Chéng | develop | the long stretch, spreading out from that point |
| 轉 Zhuǎn | turn | the change point, one or two seconds |
| 合 Hé | close | gather and resolve |

Within each level, 起 sits at the level's start and 承 follows immediately, so
the two share **one control** — a single 起承 handle that says how long the
opening strike runs. Like the end cap, it scales rather than nudges: dragging it
carries every later point by ratio, anchored on the level's end, so a longer
strike compresses the arc that follows instead of shunting one point into its
neighbour. Hold ⌥ to move just that boundary.

After a 轉 comes another 承, so repeating the middle pair extends the arc:

```
1 pair → 起承轉合
2 pairs → 起承轉承轉合
3 pairs → 起承轉承轉承轉合
```

Longer pieces stretch 承 rather than the beats that punctuate it, because 起 and
轉 are capped.

**Adding a pair never moves a point you placed.** The longest 承 region is split
by dropping a new 轉 into the middle of it followed by a new 承 — every 承 is
already followed by a 轉, so the sequence stays valid while every existing guide
keeps its exact time:

```
… 承ₖ ──────────────── 轉ₖ …     becomes     … 承ₖ ───── 轉ₙ 承ₙ ───── 轉ₖ …
```

Removing a pair merges the shortest 轉+承 run back together, so stepping the
count up and down returns to precisely where you started. **Rebalance** is the
one control that does re-lay-out a level, back to the default weighting.

### Rescaling a run of points

Marquee-drag an empty part of a guide lane (or ⌘-click points one at a time) to
select several reference lines at once. Then:

- dragging **either end** of the run rescales it by ratio, anchored on the other
  end — the same move the end cap and the 起承 handle make, bounded at both ends
- dragging a point **inside** the run slides the whole run rigidly
- points **outside** the run never move

### Scaling about a centre

**Click** any point of the run — no drag — to make it the centre. It gets a
caret and a dashed line through the lane, and the run's bracket reads *centred*.
Now dragging either end resizes the run **around that point**: the centre holds
still and both sides scale in proportion, so the run grows or shrinks
symmetrically in time rather than from one end.

```
… ●────●──────◆──────●────● …      drag the right end outward
… ●──●─────────◆─────────●──── …   the centre ◆ stays; both sides spread
```

Click the centre again — or press **Release** in the inspector — to go back to
far-end anchoring. Changing the selection clears it.

The inspector shows the run's from / span / to, takes an exact span length, and
can distribute the points inside it with **Even**, **Linear left**, **Linear
right**, **Bell shape**, **Ease in**, or **Ease out** spacing. The first and last
selected points stay fixed; the other points follow the chosen curve. Its chips
are clickable too, so the centre can be set from the panel. `Esc` collapses the
selection back to a single point.

### Layers — the content

Text clips on three tracks. Each has its own text, effect, effect parameters,
colour, size, alignment, tracking, 3D position and beat reaction, and its own
in/out points. Any number can be live at once; track 1 renders in front.
Positions are explicit scene units: `position: { x, y, z }`. A layer can choose
another text layer as its parent; its position then becomes a local offset, so
moving the parent carries the child and any deeper descendants with it. Changing
or removing a parent preserves the child's current world position.

Each text block can also carry colour keyframes. Double-click inside a block, or
press **+ Keyframe** in the selected layer's inspector, to add one at that
moment. Select a key to edit its colour and easing; key times are local to the
block, so moving the block carries the colour animation with it.

The layer's **Typeface** control can override the stage stack with any bundled
family and its available real weight, or with a font file loaded for that layer
only. The stage stack remains the fallback for characters the layer face does
not contain; **⟲** or **All from stage** restores inheritance. Built-in layer
faces are loaded on demand.

A new clip takes its default effect from the phase it starts in — drop one in a
轉 region and it arrives as Shatter, drop one in 承 and it arrives as Spread.

---

## Audio

Three lanes play together. BGM is one analysed file; VO and SFX can each contain
multiple independently positioned files, with their own level and mute:

| Lane | Purpose | Analysed |
|---|---|---|
| **BGM** | the music | yes — beats, tempo, peaks |
| **VO** | voiceover | waveform + optional local word timestamps |
| **SFX** | sound effects | waveform only |

Every audio file is a region on the timeline: grab its waveform to slip it
earlier or later, snapping to guides, bars, beats and peaks. Drag one left of
zero to trim into it. Each file has a numeric start, a level fader and a mute;
the **Add voice…** and **Add effects…** buttons append another clip to their
lane, ready to be positioned independently.

Voice clips have an **Analyse words** control. It runs a quantised
`Xenova/whisper-tiny` speech model in a worker in the browser, returning word
start/end times relative to that source. The first run downloads and caches the
model; the VO samples remain local. Once analysed, word boundaries appear on
the VO waveform and text-layer moves, trims, and new layers can snap to them
with **Snap text to VO words**. The timings move with the VO clip when it is
slipped.

The music lane is decoded on the main thread and analysed in a worker:

1. mono downmix, decimated to ~22 kHz
2. STFT → spectral flux onset envelope
3. adaptive peak picking → onsets
4. autocorrelation with harmonic reinforcement → tempo
5. joint phase + period search → the beat grid

You get BPM, a beat grid, bar lines and a waveform. Guides and clips snap to
bars and beats; **Fit to music** puts the overall lines on bars and the finer
animation lines on beats, and each layer's *Beat reaction* makes its effect
pulse on the beat.

**Beat offset** (±1000 ms) corrects the detected grid against the track; the
lane's own start positions the track against the video. Both move the grid, and
the peaks move with the music.

### Peaks

Alongside the beat grid, the analyser keeps every transient it found, and layers
and reference lines can snap to those instead of to the metre — useful when the
music does not sit on an even grid.

Two controls thin them out:

- **Minimum spacing** — no two peaks closer than this. Peaks are chosen
  strongest-first, so a thinned region keeps its loudest hit rather than merely
  its earliest one.
- **Sensitivity** — how strong a transient has to be to count at all.

Peaks show as amber ticks along the bottom of the music lane. Snap priority is
guides → bars → **peaks** → beats → clip edges.

For text-layer edits, analysed VO word boundaries are checked after the guide
lines and before the music grid.

## Metronome

A synthesised click on its own bus — it plays *over* the music rather than
instead of it, with its own voice (click, drum kit, rimshot), level, downbeat
accent and mute. Nothing is sampled; every hit is built from oscillators and
filtered noise, scheduled ahead of the playhead on the AudioContext clock.

Its tempo comes either from the analysed track or from a **manual BPM** (with
tap tempo). The manual grid works with no music loaded at all, so there is still
a metre to snap to — the beat lane shows it in a cooler colour to distinguish it
from a detected grid. `m` toggles the click; the click stays out of recordings
unless you ask for it.

---

## Backdrop colour

The **BG** track is always available as the final row of the timeline. It can render a
**Solid**, **Linear gradient**, **Circular gradient**, or **4-point gradient**.
Double-click the BG row, or press **+ Keyframe** in the Look panel, to capture
the current look at the playhead. Select a key to edit its colours, angle,
gradient centre, radius, or easing; values interpolate into the next key. With
no key selected, the controls edit the unkeyed base look. The colour plane is
composited behind backdrop video, text, particles, and the vignette/grain
overlay.

## Backdrop video

Three visual-only **V1 / V2 / V3** channels sit behind every text layer. Each
channel can hold multiple independently positioned video clips: choose several
files in one import, drag a region or edit its start time to slip it, and use
the clip-level replace/remove controls to manage the lane. Channels are
composited in order — V3 is above V2, V2 is above V1 — while later clips in one
channel sit above earlier clips.

Every clip has its own visibility, opacity, frame fitting (**Cover**,
**Contain**, or **Stretch**), optional looping, and a simple geometry mask.
Choose **Rectangle** or **Circle**, position and size it in frame percentages,
and soften its edge with **Edge blur**. **In effect** and **Out effect** each
support **Cut** or **Fade**, with an editable duration; fades cross-dissolve
overlapping clips, while an exit fade is ignored for a looping clip. Video audio
is muted by design; use the BGM, VO, or SFX lanes when sound should be part of
playback and recording.

---

## Camera track

The camera is not a layer — it moves the view, so every live clip is reframed at
once, and because the stage renders in perspective a pan gives real parallax
against glyphs that effects have pushed into depth. Its position is authored in
the same 3D scene units as the text layers.

Keys sit on their own **CAM** row, drawn as diamonds on a curve of camera depth
so the shape of the move reads at a glance. Each key holds:

| | |
|---|---|
| **Position X / Y / Z** | explicit scene-space coordinates shared with text layers |
| **Roll** | degrees |
| **Easing** | smooth, linear, ease in, ease out, or hold — governs the segment *leaving* that key |

Double-click the CAM row to drop a key, drag one to retime it (snapping to
guides, bars, beats and peaks like everything else), `k` keys the playhead,
`⌫` deletes the selected key. A new key adopts the framing already in force, so
adding one never makes the camera jump. Before the first key and after the last
the camera holds that key, which means a single key works as a static reframe.
The whole track can be switched off without discarding the keys.

Enable **Split position channels (X / Y / Z)** when the axes need different
timing. The CAM row becomes three lanes, each with its own key times, values,
and easing, so X and Y can take several position keys without creating extra
Z keys. Double-click an axis lane or use its `+ key` button to key only that
axis. **Linear full span** on Z replaces its keys with a linear start-to-end
move across the video; **Key all channels** creates a synchronized position key
when that is what the move needs. Turning split mode off merges the channel
values back into the legacy combined-key view, and older project files continue
to load in combined mode.

## 3D space view

The viewport's **3D Space** mode shows every text layer in its authored world
position, the active camera's frustum, and the camera key path. A small **Output
Preview** window overlays the 3D viewport and shows the live result from the
authored camera. It stays fixed while the scene is orbited. Drag to orbit,
shift-drag to pan, and scroll to zoom. Click a text mesh to select it; edit its
X/Y/Z coordinates in the Layer inspector. Output mode remains the camera view
used for full-size preview and recording.

## Timeline

| Gesture | Result |
|---|---|
| drag the 起承 handle | set the strike length; everything after it scales by ratio (⌥ moves the boundary alone) |
| drag any other 起承轉合 point | move that reference line on its own |
| drag an empty guide lane | marquee-select the points in that level |
| ⌘/Ctrl-click a point | add it to / remove it from the selection |
| click a point of a selected run | make it the centre the run scales about (click again to release) |
| drag either end of a selected run | rescale it — about the centre if one is set, otherwise from the far end |
| drag a point inside a selected run | slide the whole run |
| drag the animation brackets | move / stretch the animation arc inside the video |
| drag the end cap | stretch the whole composition (⌥ keeps positions, otherwise everything scales) |
| drag a clip | move it; up/down changes track |
| drag a clip edge | trim |
| double-click a track | new layer filling that phase |
| double-click inside a clip | add a colour key at that time |
| drag a colour key | retime the colour change inside its clip |
| drag a backdrop video clip | slip that clip earlier or later |
| drag a waveform | slip that lane earlier or later (left of zero trims in) |
| no audio or backdrop video loaded | the unused media lanes collapse to save space |
| drag the ruler | scrub; hold ⇧ to snap to reference lines and the beat grid |
| wheel / ⇧wheel | zoom / pan |
| ⇧ while dragging edits | ignore snapping; while dragging the ruler, ⇧ enables snapping |

Keys: `space` play · `←/→` step a frame (`⇧` ten) · `↑/↓` select layer ·
`[` `]` jump to in/out · `n` new layer · `k` camera key · `m` metronome ·
`⌘Z` undo · `⌘⇧Z` redo ·
`⌘D` duplicate · `⌘C` copy · `⌘V` paste at the playhead · `⌫` delete · `f` fit · `l` loop.

Copy/paste uses the system clipboard when available and keeps an in-app
fallback. A pasted layer preserves its visual offset from the camera at copy
time, then accumulates the camera's current frame offset, so moving the camera
does not strand a newly created layer at world origin. New layers from **Add
text** use the same camera-relative placement.

**A focused slider owns the arrow keys.** Click any property slider and `←/→`
nudge that value by one step instead of scrubbing the timeline; the slider draws
a focus ring so it is clear where the keyboard is pointing. `Esc` releases it and
hands the arrows back to the transport, and `space` still starts playback either
way, since a range input does nothing with it. Panels that rebuild themselves —
the camera key editor, the audio lane faders — skip the rebuild while a control
inside them has focus, so the value under your finger is never yanked away
mid-adjustment.

---

## Effects

Each effect is a pure function of `(glyph slot, progress through the clip)` that
writes a transform, so it owns its whole arc — entrance, life and exit. Twenty
of them, grouped by the phase they suit; the inspector offers a phase's own
effects first and the rest below.

| Phase | Effects |
|---|---|
| **起** open | Strike · Rise · Bloom · Typewriter · Unfold |
| **承** develop | Spread · Breathe · Wave · Drift · Tracking |
| **轉** turn | Shatter · Flip · Glitch · Explode · Scramble · Unfold |
| **合** close | Converge · Collapse · Dissolve |
| any | Zoom · Hold |

Every effect reads the same context — the glyph's index in the line, progress
through the clip, elapsed time, and a beat pulse that decays from each beat and
is scaled by the clip's *Beat reaction*. Effects never touch the DOM or the
store, which is why adding one is a single object in `js/effects.js`.

---

## Typography

Outlines are extracted with opentype.js and triangulated into three.js meshes,
one mesh per glyph, which is what lets effects move characters independently.
Counters are detected by containment plus winding rather than winding alone, so
CJK faces — where separate strokes routinely overlap — come out right.

### Kerning

Pair kerning comes from the **browser's shaper**, not from opentype.js. The same
font file is registered as a `FontFace` and measured on a canvas: a pair's kern
is what the pair measures minus what its two glyphs measure alone, cached per
pair.

This is not belt-and-braces. opentype.js reads the legacy `kern` table and plain
GPOS PairPos lookups, but it does not resolve **GPOS lookup type 9 (Extension
Positioning)** — and that is where many modern families keep their real pair
kerning. Inter's letter pairs and the *entire* kern feature of Playfair Display
sit behind an extension lookup, so opentype reports `0` for every pair (both
1.3.4 and 2.0.0 do this). Measured against the platform shaper, Inter's `AV`
is −79/1000 em, `Yo` is −109/1000 em.

Where opentype *can* read the data the two agree exactly — Noto Sans TC returns
identical values from both paths — so the measurement is a strict improvement,
and opentype's own value is still the fallback when a face cannot be registered.

### Font fallback stack

Three slots, tried in order. Each character is drawn with the first font that
actually has a glyph for it, so a Latin display face can carry the headline
while a CJK face picks up 起承轉合 — in one line, on one baseline. Line metrics
come from the primary font; kerning only applies within a single font.

The default stack is Inter Bold with Noto Sans TC Bold behind it. Any slot takes
a bundled face (Noto Sans TC, Inter, Bebas Neue, Playfair Display, loaded from
jsDelivr) or your own `.ttf` / `.otf` / `.woff`. A layer can independently lead
with any bundled family / weight without changing those three stage slots.

---

## Export

**Record** captures the canvas in real time, with the music muxed in. The file is
MP4 (H.264) where the browser can mux it — Safari and Chrome 130+ — and WebM
otherwise (Firefox). The saved extension always matches the actual format.
The canvas is always rendered at the project's true pixel size, so the recording
is 1:1 with the composition.

**Save** / **Open** write a `.ktc.json` project file. Audio and backdrop settings
are saved, while the source files are referenced by name rather than embedded —
reload each source after opening a project.

---

## Undo and redo

`Undo` / `Redo` in the top bar, `⌘Z` / `⌘⇧Z` (`⌘Y` also redoes). Each button
names the step it will reverse — *Undo delete layer*, *Undo add camera key* —
so it is clear what is about to move before it moves.

**A gesture is one step, not one step per pixel.** Dragging a layer the width of
the timeline, sweeping a slider, or typing a line of text each undo in a single
press: a change waits for the pointer to come up and the keystrokes to stop
before it becomes an entry. A discrete action — a button, a keyboard shortcut —
becomes an entry immediately, so two quick presses stay two separate steps.

**Undo covers the composition, not the media.** Everything in the project file —
structure, layers, camera, particles, size, duration, look — is on the stack.
Importing or removing audio and backdrop video is not, because the browser owns
those decoded buffers and no snapshot can conjure them back. The trade is
deliberate: undoing a text edit can never silently detach a soundtrack. Opening
a project starts a fresh history, as does loading the app.

Undoing a delete restores the selection along with the layer, so the thing that
came back is the thing that is selected.

## Autosave and recovery

The composition is written to `localStorage` whenever the editing goes quiet —
about a second after the last change, and at least every eight seconds through a
long unbroken gesture — and again when the tab is hidden or closed. Reopening
the app restores that snapshot instead of the demo arrangement, so a crashed
tab, a stray `⌘W` or a reload costs nothing. A toast says what came back and how
old it was.

It is deliberately the *same document* `Save` writes: one serializer, one reader,
one set of migrations, and a snapshot written by a newer build is left alone
rather than opened half-understood. That also means it holds media the same way
a project file does — as references — so recovery finishes exactly as opening a
file does, by pulling the bytes back out of the local media cache. Typefaces
come back as far as they can: a preset reloads from its URL, a font file the
user supplied cannot, and that slot falls back to the default.

The recovered project is the floor of the undo stack, not a step in it — undo
cannot rewind past the recovery into the demo arrangement. `New` in the top bar
is the way back to an empty composition: it discards the current one, the
autosave included, and asks first because nothing else undoes it.

With no usable `localStorage` — a private window, blocked storage, a page opened
over `file://` — or when the quota is full, autosave says so once and the app
runs exactly as it did before, minus the recovery.

## Project file

`Save` writes a `.ktc.json` shaped like this. Buffers and font binaries are never
embedded — only the names needed to re-attach them.

```jsonc
{
  "format": "kinetic-typography-composer",
  "version": 13,
  "project": {
    "name": "…", "width": 1080, "height": 1080, "fps": 30, "duration": 24,
    "bg": "#08090c", "vignette": 0.45, "grain": 0.06, "depth": 0,
    "backdrop": {
      "mode": "linear", "colors": ["#08090c", "#1b2333", "#26344a", "#101722"],
      "angle": 0, "center": { "x": 0.5, "y": 0.5 }, "radius": 0.75,
      "keys": [{ "id": "bk_…", "t": 0, "ease": "smooth",
                 "colors": ["#08090c", "#1b2333", "#26344a", "#101722"] }]
    },

    // 起承轉合 reference lines, two levels, each with its own span
    "levels": {
      "overall":   { "key": "overall",   "repeats": 1, "start": 0, "end": 24,
                     "guides": [{ "id": "g_…", "role": "qi", "t": 0 }] },
      "animation": { "key": "animation", "repeats": 3, "start": 0, "end": 24,
                     "guides": [] }
    },

    // the layers that actually render
    "clips": [{
      "id": "c_…", "start": 0, "end": 8, "track": 0,
      "text": "KINETIC", "effect": "strike", "params": { "impact": 1.5 },
      "color": "#ffffff", "size": 0.2, "align": "center",
      "lineHeight": 1.25, "tracking": 0,
      "fontFamily": "Inter", "fontWeight": 400,
      "colorKeys": [{ "id": "cck_…", "t": 2.5, "color": "#f472b6", "ease": "smooth" }],
      "parentId": null,
      "position": { "x": 0, "y": 0, "z": 0 },
      "beatReact": 0.25
    }],

    // keyframed framing
    "camera": {
      "enabled": true,
      "mode": "combined",             // or "split" for independent X/Y/Z channels
      "keys": [{ "id": "ck_…", "t": 0,
                 "position": { "x": 0, "y": 0, "z": 1483.0 },
                 "roll": 0, "ease": "smooth" }]
      // split mode also stores channels: { "x": [{ "t": 0, "value": 0, "ease": "smooth" }], ... }
    }
  },

  "audio": {                       // null when nothing is loaded
    "bpm": 120.1, "offset": 0, "beatsPerBar": 4, "hitGap": 0.35, "hitSense": 0.2,
    "tracks": {
      "bgm": { "name": "song.wav", "start": 0, "volume": 1, "mute": false, "duration": 16 },
      "vo": { "clips": [
        { "name": "intro.wav", "start": 0, "volume": 1, "mute": false, "duration": 2.4 },
        { "name": "line-2.wav", "start": 3.1, "volume": 1, "mute": false, "duration": 1.8 }
      ] },
      "sfx": { "clips": [] }
    }
  },
  "video": {                       // null when no backdrop is loaded
    "channels": {
      "v1": { "clips": [{
        "id": "v_…", "name": "texture.mp4", "start": 0, "opacity": 1,
        "fit": "cover", "loop": true, "visible": true, "duration": 12,
        "inEffect": "fade", "inDuration": 0.5,
        "outEffect": "fade", "outDuration": 0.5,
        "mask": { "shape": "none", "x": 0.5, "y": 0.5,
                  "width": 0.72, "height": 0.72, "blur": 0 }
      }] }
    }
  },
  "metro": { "on": false, "voice": "kit", "volume": 0.7, "source": "track", "bpm": 120 },
  "fonts": [{ "name": "Inter · Bold", "preset": "inter-700" }, null, null]
}
```

---

## Development notes

The decisions that were not obvious, and the bugs that came out of testing.

**Guides are not containers.** The first cut modelled 起承轉合 as stages that
owned their content. That was wrong: they are reference lines, like a grid on a
canvas, and content is a separate layer list that merely snaps to them. Almost
every later feature — two levels, multi-select, camera keys — only works because
of that separation.

**Editing must be non-destructive.** Adding a 承轉 pair splits the longest 承
rather than re-laying-out the level, so hand-placed points never move; stepping
the count up and down is lossless. `Rebalance` is the single control that
deliberately re-flows a level.

**CJK counters need containment, not winding.** Deciding holes by winding
direction alone turns 起 into a solid blob, because CJK faces routinely draw
overlapping strokes: one stroke's start point lands inside its neighbour and gets
punched out. A contour is only a counter when it is *wholly* inside another
(bounding box included) and wound the other way.

**Overlapping strokes must not double-blend.** Those same overlaps show as
bright seams while a glyph fades. Flat glyph material uses
`depthWrite: true` with `depthFunc: LessDepth`, which rejects coplanar re-draws,
so a glyph fades as one shape.

**Kerning comes from the browser, not the font library.** opentype.js does not
resolve GPOS lookup type 9 (Extension Positioning) in either 1.3.4 or 2.0.0 —
and that is where Inter's letter pairs and the whole of Playfair Display's kern
feature live, so it reports `0` for every pair. Metrics are measured with the
platform shaper instead; where opentype *can* read the data the two agree
exactly, which is what validates the swap.

**The transport clock cannot depend on the AudioContext alone.** It rides
`AudioContext.currentTime` while audio is genuinely running, so nothing drifts
against the track, and falls back to `performance.now()` when the context has
not been resumed — a suspended context reports a frozen `currentTime`, which
would otherwise stall the whole composition. It re-bases on the switch so the
playhead stays continuous.

**The metronome fired every beat twice.** A unit test of the scheduler caught it:
the "did the transport jump?" check mistook normal lookahead scheduling for a
seek and kept re-seeking onto the beat it had just queued. It now compares
against the previous transport reading and only re-seeks on a genuine jump.

**Analysis latency is real and correctable.** A transient shows up in the
spectral flux about half an analysis window *before* it actually sounds, so
every onset and beat is pushed later by `FRAME / 2` samples to put it back where
it belongs. That correction moved the detected downbeat from 0.229 s to 0.253 s
against a true 0.25 s.

---

## Layout

```
index.html                 shell + panels
serve.py                   dev server: no-cache headers, correct MIME types
css/app.css                chrome Tailwind does not cover
js/main.js                 bootstrap, transport, frame loop
js/state.js                project store, backdrop colour track + event bus
js/history.js              undo / redo — project snapshots, one per gesture
js/autosave.js             crash recovery — the project kept in localStorage
js/structure.js            起承轉合 levels, guides, pattern, weighting
js/camera.js               keyframed camera track
js/effects.js              the effect library
js/typography.js           opentype.js → three.js geometry
js/renderer.js             three.js stage, compositing
js/timeline.js             canvas timeline, all editing gestures
js/ui.js                   panel wiring
js/util.js                 maths, easing, formatting, DOM helpers
js/export.js               MP4 / WebM capture
js/audio/engine.js         three-lane playback, transport clock, worker hand-off
js/audio/metronome.js      synthesised click bus + manual tempo grid
js/audio/analyzer.worker.js  FFT, onsets, tempo, beat grid
js/video/engine.js         muted backdrop video elements and transport sync
```
