# Kinetic Typography Composer

A browser-based composer for beat-driven kinetic typography, built around the
classical 起承轉合 dramatic structure.

Plain HTML + vanilla ES modules + Tailwind (play CDN).
Glyph outlines come from **opentype.js**; every effect runs in **three.js**.

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

Two independent things live in a composition.

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

The inspector shows the run's from / span / to, takes an exact span length, and
can **Distribute** the points inside it evenly. `Esc` collapses the selection
back to a single point.

### Layers — the content

Text clips on three tracks. Each has its own text, effect, effect parameters,
colour, size, alignment, tracking, offset and beat reaction, and its own in/out
points. Any number can be live at once; track 1 renders in front.

A new clip takes its default effect from the phase it starts in — drop one in a
轉 region and it arrives as Shatter, drop one in 承 and it arrives as Spread.

---

## Audio

Three lanes play together, each with its own file, position, level and mute:

| Lane | Purpose | Analysed |
|---|---|---|
| **BGM** | the music | yes — beats, tempo, peaks |
| **VO** | voiceover | waveform only |
| **SFX** | sound effects | waveform only |

Every lane is a region on the timeline: grab its waveform to slip it earlier or
later, snapping to guides, bars, beats and peaks. Drag one left of zero to trim
into it. Each lane also has a numeric start, a level fader and a mute.

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

The transport clock rides the `AudioContext` while audio is genuinely running,
so nothing drifts against the track, and falls back to `performance.now()` when
the context has not been resumed — a suspended context reports a frozen
`currentTime`, which would otherwise stall the whole composition.

---

## Camera track

The camera is not a layer — it moves the view, so every live clip is reframed at
once, and because the stage renders in perspective a pan gives real parallax
against glyphs that effects have pushed into depth.

Keys sit on their own **CAM** row, drawn as diamonds on a curve of the zoom
value so the shape of the move reads at a glance. Each key holds:

| | |
|---|---|
| **Pan X / Y** | fractions of the frame, so a move survives a change of resolution |
| **Zoom** | multiple of the default framing (0.2–4×) |
| **Roll** | degrees |
| **Easing** | smooth, linear, ease in, ease out, or hold — governs the segment *leaving* that key |

Double-click the CAM row to drop a key, drag one to retime it (snapping to
guides, bars, beats and peaks like everything else), `k` keys the playhead,
`⌫` deletes the selected key. A new key adopts the framing already in force, so
adding one never makes the camera jump. Before the first key and after the last
the camera holds that key, which means a single key works as a static reframe.
The whole track can be switched off without discarding the keys.

## Timeline

| Gesture | Result |
|---|---|
| drag the 起承 handle | set the strike length; everything after it scales by ratio (⌥ moves the boundary alone) |
| drag any other 起承轉合 point | move that reference line on its own |
| drag an empty guide lane | marquee-select the points in that level |
| ⌘/Ctrl-click a point | add it to / remove it from the selection |
| drag either end of a selected run | rescale the run by ratio, anchored on the other end |
| drag a point inside a selected run | slide the whole run |
| drag the animation brackets | move / stretch the animation arc inside the video |
| drag the end cap | stretch the whole composition (⌥ keeps positions, otherwise everything scales) |
| drag a clip | move it; up/down changes track |
| drag a clip edge | trim |
| double-click a track | new layer filling that phase |
| double-click a clip | zoom to it |
| drag a waveform | slip that lane earlier or later (left of zero trims in) |
| drag the ruler | scrub |
| wheel / ⇧wheel | zoom / pan |
| ⇧ while dragging | ignore snapping |

Keys: `space` play · `←/→` step a frame (`⇧` ten) · `↑/↓` select layer ·
`[` `]` jump to in/out · `n` new layer · `k` camera key · `m` metronome ·
`⌘D` duplicate · `⌫` delete · `f` fit · `l` loop.

---

## Effects

Each effect is a pure function of `(glyph slot, progress through the clip)` that
writes a transform, so it owns its whole arc — entrance, life and exit.

- **起** Strike, Rise, Bloom, Typewriter, Unfold
- **承** Spread, Breathe, Wave, Drift, Tracking
- **轉** Shatter, Flip, Glitch, Explode, Scramble
- **合** Converge, Collapse, Dissolve
- **any** Zoom, Hold

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
jsDelivr) or your own `.ttf` / `.otf` / `.woff`.

---

## Export

**Record** captures the canvas in real time to WebM, with the music muxed in.
The canvas is always rendered at the project's true pixel size, so the recording
is 1:1 with the composition.

**Save** / **Open** write a `.ktc.json` project file. Audio is referenced by
name, never embedded — reload the track after opening a project.

---

## Layout

```
index.html                 shell + panels
css/app.css                chrome Tailwind does not cover
js/main.js                 bootstrap, transport, frame loop
js/state.js                project store + event bus
js/structure.js            起承轉合 levels, guides, pattern, weighting
js/camera.js               keyframed camera track
js/effects.js              the effect library
js/typography.js           opentype.js → three.js geometry
js/renderer.js             three.js stage, compositing
js/timeline.js             canvas timeline, all editing gestures
js/ui.js                   panel wiring
js/export.js               WebM capture
js/audio/engine.js         three-lane playback, transport clock, worker hand-off
js/audio/metronome.js      synthesised click bus + manual tempo grid
js/audio/analyzer.worker.js  FFT, onsets, tempo, beat grid
```
