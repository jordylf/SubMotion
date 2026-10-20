# SubMotion architecture

## 1. Adobe API audit (October 2026)

| Need | Premiere Pro | After Effects |
|---|---|---|
| Panel tech available to third parties | **UXP** (GA) and **CEP** (still supported) | **CEP** only. No generally available UXP panel API. |
| Read caption track text | **Not possible.** UXP can see `CaptionTrack` items but cannot read or edit their content. Adobe staff confirm "not available yet". ExtendScript can't either. | n/a (no caption tracks). Text layers are fully readable. |
| Create animated text from script | No API to create text with animators. **`Sequence.importMGT()`** (ExtendScript) places a `.mogrt`, and its Essential Graphics params are settable via `getMGTComponent()`. | Full DOM: text layers, Text Animators, Expression Selectors, effects, markers, expressions. |
| Build a `.mogrt` from script | — | `addToMotionGraphicsTemplateAs()` + `exportAsMotionGraphicsTemplate()` (AE 16.1+). |
| Undo grouping | No undo-group API | `app.beginUndoGroup()` |

Sources: CC Developer forums ([caption read](https://forums.creativeclouddeveloper.com/t/how-do-i-read-and-update-caption-content-in-premiere-pro/9148),
[caption wishlist, Mar 2026](https://forums.creativeclouddeveloper.com/t/captions-apis-wish-list-items/10937)),
[Adobe community: CaptionTrack via UXP](https://community.adobe.com/t5/premiere-pro-discussions/issue-accessing-caption-items-via-captiontrack-api-in-premiere-pro-uxp-scripting/m-p/15436511).

## 2. Decision: one CEP panel + ExtendScript adapters + a pure TypeScript core

- **CEP** is the only panel technology that runs in both apps today, so one panel serves both.
- **ExtendScript** is the only way to drive AE's DOM and Premiere's `importMGT`.
- **All logic that isn't an Adobe call** (parsing, language, numbers, keywords, splitting, layout,
  presets, and even the animation curves) lives in a host-independent **TypeScript core**. It is
  unit-tested in Node, without Adobe.
- **Migration path:** when Premiere's UXP gains caption read/write, add a `UxpPremiereHost`
  implementing `AdobeHostAdapter` (`src/core/host-adapter.ts`). The core does not change.

### Workarounds (instead of faking unavailable APIs)

| Limitation | Workaround |
|---|---|
| Premiere can't read captions | User exports captions as SRT (*File › Export › Captions*) and loads it. AE can also read selected text layers, including one layer with Source Text keyframes. |
| Premiere can't create animated text | SubMotion **builds its own `.mogrt` in After Effects** (*Manage › Build Premiere Template*). Premiere places one instance per caption and sets its parameters. |
| No keyframes wanted | All motion is **procedural**: one shared expression function `smEnv(t, type, intensity)` drives scale, opacity, offset and blur from time since the word appeared. |

## 3. Data flow

```
SRT/VTT ─┐
AE text ─┴─> subtitle-parser ─> language-engine ─> keyword-engine ─> text-engine ─> layout-engine
               (cues)           tokenize, fillers,   0..100 scores    DP split,       lines, safe area,
                                numbers, detect                       emphasis, timing font scale
                                                                                │
                         preset-engine (style) + animation-engine (expressions) ┤
                                                                                ▼
                                                    pipeline.buildHostJob / toHostCaption
                                                                                │  JSON over CEP evalScript
                                                         ┌──────────────────────┴───────────────────┐
                                              after-effects/host.jsx                   premiere/host.jsx
```

The panel sends **one job** (style, controls, expressions), then captions in **batches**
(20 in AE, 10 in Premiere). Between batches the UI repaints, updates the progress bar and checks
the Cancel flag, so the host never freezes for the whole run.

## 4. Output structure

### After Effects (like CapComp: every word is a layer)
```
<your comp>
 └─ SubMotion Captions              (comp layer; comment stores the target comp id)
     ├─ SubMotion Controls          null: Animation, Emphasis Animation, Animate Emphasis,
     │                              Intensity, Speed %, Normal/Emphasis/Active Color, Active Word Highlight
     ├─ 0001 Gue kira harganya cuma (precomp, trimmed to caption time)
     │    ├─ Gue      text layer: starts when spoken, marker "normal" (duration = spoken time)
     │    ├─ ...
     ├─ 0002 50 RIBU
     │    └─ 50 RIBU  text layer, marker "emph", bigger font
Project panel: "SubMotion Precomps" folder
```
- **Editable:** text, font, size and stroke are ordinary text properties. Position is static (the
  expression only adds animation offsets). Timing is the layer/precomp in/out. Emphasis is toggled by
  changing the marker comment to `emph`/`normal`. Global look comes from the Controls null.
- Don't rename `SubMotion Captions` or `SubMotion Controls`; expressions reference them by name.

### Premiere Pro
One `SubMotion Caption 1080x1920` (or `1920x1080`) graphic clip per caption on an empty top
track. Parameters (Essential Graphics panel): Caption, Keywords (1-based word indices), Word Times
(seconds per word), Animation, Emphasis Animation, Animate Emphasis, Intensity, Speed %, Normal /
Emphasis / Active Color, Active Word Highlight, Size %, Position Y %, Max Width %.
Inside the template, words are addressed with Expression Selectors (*Based On: Words*), so
word-by-word reveal, keyword color and keyword punch all work on a single text layer.

## 5. Engines

| Engine | File | Interface |
|---|---|---|
| Subtitle parser | `core/subtitle-parser` | `parseSubtitles(text): SourceCaption[]` |
| Language processor | `core/language-engine` + `languages/*` | `LanguagePack`, `detectLanguage`, `tokenize`, `removeFillers`, `normalizeNumbers` |
| Keyword analyzer | `core/keyword-engine` | `scoreKeywords(tokens, lang)` |
| Subtitle processor (splitter) | `core/text-engine` | `chunkTokens` (dynamic programming, O(n·maxWords)), `buildCaptions` |
| Layout | `core/layout-engine` | `computeLayout`, `breakLines`, `layoutCaptions` |
| Presets | `core/preset-engine` | `PresetManager`, `validatePreset` |
| Animation | `core/animation-engine` | `ENV_FN`, `aeWordExpressions`, `mogrtExpressions` |
| Host adapter | `core/host-adapter.ts` | `AdobeHostAdapter`, `CepHost` |

### Why the adapter is batch-shaped
The spec suggested per-property methods (`setFont`, `setPosition`…). Every CEP→ExtendScript call
is an IPC round trip, so 2000 captions × ~8 properties would be ~16,000 round trips. The adapter
therefore exposes `prepare / createBatch / finish / deleteGenerated`, and the ExtendScript side does
the per-layer work locally.

### Splitter cost model (text-engine)
Each candidate caption `tokens[j..i)` gets a cost. The DP picks the cheapest segmentation.
- **Hard limits:** `maxWords`, `maxChars`, no pause longer than 0.8 s inside a caption.
- **Penalties:** fewer than `minWords` (waived for an isolated strong keyword or a reveal beat
  such as "Ternyata"), ending on a function word (`yang`, `di`, `the`, `of`…), starting on a
  clinging particle (`kan`, `sih`…), a sentence end inside a caption, reading speed above 20 cps,
  and a strong keyword buried in a longer caption (when `isolateKeywords`).
- **Bonuses:** breaking after punctuation, at pauses, before contrast words (`tapi`, `but`), and
  before a strong keyword.

## 6. Transcription (local Whisper)

```
host.mediaSource()  ──>  ui/transcriber.ts (CEP Node.js)          ──>  core/transcript
  file path +              ffmpeg: trimmed range → 16 kHz mono WAV        parseWhisperJson (glue sub-words)
  timeline mapping         whisper-cli -ml 1 -sow -oj (word segments)     placeWords (media → timeline)
  (offset, rate,           progress from stderr, cancel = kill            wordsToCues (pauses, sentence ends)
   from, to)                                                                     │
                                                    SourceCaption.words ──> tokenize() uses real word times
```
- `timelineTime = offset + mediaTime × rate`. AE: `offset = layer.startTime`, `rate = stretch/100`.
  Premiere: `offset = clip.start − clip.inPoint/speed`, `rate = 1/speed`.
- Only `[from, to]` (the visible part of the clip) is extracted, so a short clip from a long file
  stays fast.
- whisper.cpp was chosen over cloud APIs: free, offline, no key, good Indonesian, word timestamps.
  A cloud engine can implement the same `transcribe()` contract later.

## 7. Normal / Emphasis styling

Every style value exists twice (Normal, Emphasis). Where each one is applied:

| Setting | After Effects (word layers) | Premiere (.mogrt, one text layer) |
|---|---|---|
| Font | per layer | template font only |
| Size | per layer font size | Emphasis Size % → scale animator on keyword words |
| Color | Controls null → fill animator | Normal/Emphasis Color params → fill animators |
| Animation, intensity | Controls null dropdowns/sliders | same params |
| Shadow, glow | Drop Shadow effects per class | not per class |
| Stacked lines | real per-line heights (big emphasis lines get room) | line breaks in text |
