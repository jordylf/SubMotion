import type { EffectName, Frame, Preset, ProcessOptions, SourceCaption } from '../core/types.ts';
import { parseSubtitles } from '../core/subtitle-parser/index.ts';
import { EFFECTS, PresetManager, validatePreset } from '../core/preset-engine/index.ts';
import { ANIMATIONS, ANIMATION_LABELS } from '../core/animation-engine/index.ts';
import { computeLayout } from '../core/layout-engine/index.ts';
import {
  DEFAULT_OPTIONS, TEMPLATES, TEMPLATE_FONT, buildHostJob, mogrtComplete, premiereFit, processSubtitles, toHostCaption,
  type ProcessResult,
} from '../core/pipeline.ts';
import { CepHost } from '../core/host-adapter.ts';
import { placeWords, wordsToCues } from '../core/transcript/index.ts';
import { detectWhisperDefaults, nodeRequire, transcribe, transcriptionAvailable, userDataDir, type WhisperConfig } from './transcriber.ts';
import { downloadTools } from './models.ts';
import { EFFECT_INFO, FALLBACK_FONTS, card, fontCss, presetPreview, sample, setFonts, styleSample, type FontEntry } from './cards.ts';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
// Per host app: AE and Premiere panels share one localStorage origin, and must not overwrite each other.
const storeKey = () => `submotion.settings.v2.${host ? host.app : 'browser'}`;
const OPTION_KEYS = ['smartLineBreak', 'highlightKeywords', 'animateKeywords', 'detectNumbers', 'autoResize', 'safeArea', 'wordHighlight', 'removeFillers'] as const;
const WHISPER_KEYS = ['whisperPath', 'modelPath', 'ffmpegPath'] as const;
const CLASS_TABS = new Set(['motion', 'effects', 'font']);

const cepRuntime = (window as unknown as { __adobe_cep__?: ConstructorParameters<typeof CepHost>[0] }).__adobe_cep__;
const host = cepRuntime ? new CepHost(cepRuntime) : null;
const presets = new PresetManager();

let cues: SourceCaption[] = [];
let frame: Frame & { name?: string; fps?: number } = { width: 1080, height: 1920 };
let presetId = 'stack';
let current: Preset = presets.get(presetId); // the live style: chosen preset + edits
let cls: 0 | 1 = 0; // Normal / Emphasis being edited
let tab = 'source';
let fonts: FontEntry[] = FALLBACK_FONTS;
let fontLimit = 60;
let cancelled = false;
let cancelAction: (() => void) | null = null;
let busy = false;

// ---------- settings ----------

interface Saved { preset?: string; style?: Partial<Preset>; language?: string; options?: Partial<ProcessOptions>; whisper?: Partial<WhisperConfig>; tab?: string; cls?: 0 | 1; premiereOutput?: string }

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) ?? '{}');
  } catch {
    return {};
  }
}

function persist() {
  try {
    const saved: Saved = { preset: presetId, style: current, language: $('language').value, options: options(), whisper: typedWhisperPaths(), tab, cls, premiereOutput: $('premiereOutput').value };
    localStorage.setItem(storeKey(), JSON.stringify(saved));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

function options(): ProcessOptions {
  const o = { ...DEFAULT_OPTIONS, language: $<HTMLSelectElement>('language').value as ProcessOptions['language'] };
  for (const k of OPTION_KEYS) o[k] = $(k).checked;
  return o;
}

function style(): Preset {
  return { ...current, minWords: Math.max(1, Math.min(current.minWords, current.maxWords)) };
}

const detected = () => detectWhisperDefaults(host?.extensionPath());

/** Each field: what the user typed, else what SubMotion found (bundled / downloaded / legacy). */
function whisperConfig(): WhisperConfig {
  const found = detected();
  const pick = (id: string, auto?: string) => $(id).value.trim() || auto || '';
  return {
    whisperPath: pick('whisperPath', found.whisperPath),
    modelPath: pick('modelPath', found.modelPath),
    ffmpegPath: pick('ffmpegPath', found.ffmpegPath) || 'ffmpeg',
    vadModelPath: found.vadModelPath,
  };
}

/** Only what the user typed is saved, so detected (absolute, install-specific) paths never go stale. */
const typedWhisperPaths = (): Partial<WhisperConfig> =>
  Object.fromEntries(WHISPER_KEYS.map((k) => [k, $(k).value.trim()]).filter(([, v]) => v));

/** Class-dependent fields: [normal key, emphasis key]. */
const CLASS_KEYS = {
  color: ['textColor', 'keywordColor'],
  intensity: ['intensity', 'emphasisIntensity'],
  animation: ['animation', 'emphasisAnimation'],
  effects: ['normalEffects', 'emphasisEffects'],
  font: ['font', 'emphasisFont'],
} as const;
const ck = <K extends keyof typeof CLASS_KEYS>(k: K): (typeof CLASS_KEYS)[K][0 | 1] =>
  CLASS_KEYS[k][cls] as (typeof CLASS_KEYS)[K][0 | 1];

function edit(patch: Partial<Preset>) {
  current = { ...current, ...patch };
  render();
  refresh();
}

// ---------- rendering ----------

function render() {
  // Plain inputs bound with data-key.
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-key]')) {
    const v = current[el.dataset.key as keyof Preset];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = String(v ?? '');
  }
  $('speedOut').textContent = `${current.speed}%`;
  $('velocityOut').textContent = String(current.velocity);

  // Class-dependent inputs.
  const intensity = current[ck('intensity')];
  $('clsIntensity').value = String(intensity);
  $('clsIntensityOut').textContent = String(intensity);
  $('clsColor').value = current[ck('color')];
  $('clsSizeLabel').textContent = cls ? 'Size (× normal)' : 'Size (px @1080)';
  const size = $('clsSize');
  Object.assign(size, cls ? { min: '0.5', max: '3', step: '0.05' } : { min: '10', max: '400', step: '1' });
  if (document.activeElement !== size) size.value = String(cls ? current.emphasisSizeMul : current.fontSize);

  for (const b of document.querySelectorAll<HTMLElement>('.classbar [data-class]'))
    b.setAttribute('aria-checked', String(Number(b.dataset.class) === cls));
  const showCounts = tab === 'effects';
  $('countNormal').textContent = showCounts ? String(current.normalEffects.length || '') : '';
  $('countEmph').textContent = showCounts ? String(current.emphasisEffects.length || '') : '';

  if (tab === 'style') renderPresets();
  if (tab === 'motion') renderAnimations();
  if (tab === 'effects') renderEffects();
  if (tab === 'font') renderFonts();
}

function renderPresets() {
  $('presetGrid').replaceChildren(
    ...presets.list().map((p) => {
      const { el, stage } = card(p.name);
      el.setAttribute('aria-pressed', String(p.id === presetId));
      stage.append(presetPreview(p));
      el.onclick = () => {
        presetId = p.id;
        current = { ...p };
        render();
        refresh();
      };
      return el;
    }),
  );
}

function renderAnimations() {
  const chosen = current[ck('animation')];
  $('animGrid').replaceChildren(
    ...ANIMATIONS.map((a, i) => {
      const { el, stage } = card(ANIMATION_LABELS[i], `a-${a}`);
      el.setAttribute('role', 'radio');
      el.setAttribute('aria-checked', String(a === chosen));
      const s = sample(cls ? 'WOW' : 'motion');
      styleSample(s, current, cls);
      stage.append(s);
      el.onclick = () => edit({ [ck('animation')]: a });
      return el;
    }),
  );
}

function renderEffects() {
  const list = current[ck('effects')];
  $('effectGrid').replaceChildren(
    ...EFFECTS.map((fx) => {
      const { el, stage } = card(EFFECT_INFO[fx]);
      el.setAttribute('aria-pressed', String(list.includes(fx)));
      const s = sample('EFFECT');
      styleSample(s, current, cls, [fx]);
      stage.append(s);
      el.onclick = () => {
        const next: EffectName[] = list.includes(fx) ? list.filter((e) => e !== fx) : [...list, fx];
        edit({ [ck('effects')]: next });
      };
      return el;
    }),
  );
}

function renderFonts() {
  const q = $('fontSearch').value.trim().toLowerCase();
  const chosen = current[ck('font')] || (cls ? current.font : '');
  const matches = fonts.filter(([ps, fam, st]) => !q || `${fam} ${st} ${ps}`.toLowerCase().includes(q));
  // Keep the selected font visible at the top.
  matches.sort((a, b) => Number(b[0] === chosen) - Number(a[0] === chosen));
  $('fontGrid').replaceChildren(
    ...matches.slice(0, fontLimit).map(([ps, fam, st]) => {
      const { el, stage } = card(`${fam} ${st}`);
      el.setAttribute('role', 'radio');
      el.setAttribute('aria-checked', String(ps === chosen));
      el.title = ps;
      const s = sample('Caption');
      Object.assign(s.style, fontCss(ps), { color: current[ck('color')] });
      stage.append(s);
      el.onclick = () => edit({ [ck('font')]: ps });
      return el;
    }),
  );
  $('moreFonts').hidden = matches.length <= fontLimit;
}

function showTab(name: string) {
  tab = name;
  for (const b of document.querySelectorAll<HTMLElement>('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll<HTMLElement>('[data-panel]')) s.hidden = s.dataset.panel !== name;
  $('classbar').hidden = !CLASS_TABS.has(name);
  render();
  persist();
}

// ---------- processing + caption list ----------

let cache: { key: string; result: ProcessResult } | null = null;

/** Memoized: caption list, Preview and Generate all reuse one processing pass. */
function process(): ProcessResult {
  const st = style(), opts = options();
  const key = JSON.stringify([cues.length, cues[0]?.text, cues[cues.length - 1]?.end, st, opts, frame]);
  if (cache?.key !== key) cache = { key, result: processSubtitles(cues, st, opts, frame) };
  return cache.result;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function renderList() {
  const list = $<HTMLOListElement>('captionList');
  list.replaceChildren();
  if (!cues.length) return;
  const { captions, language, confidence } = process();
  $('captionCount').textContent = `${captions.length}`;
  $('sourceInfo').textContent =
    `${cues.length} cues · ${language === 'id' ? 'Bahasa Indonesia' : 'English'}` +
    ($('language').value === 'auto' ? ` (auto ${Math.round(confidence * 100)}%)` : '') +
    ` · ${frame.width}×${frame.height}`;
  for (const c of captions.slice(0, 80)) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmt(c.start);
    const text = document.createElement('span');
    c.words.forEach((w, k) => {
      const s = document.createElement('span');
      s.textContent = w.text;
      if (w.emphasis) s.className = 'kw';
      if (c.words[k + 1] && c.words[k + 1].line !== w.line) s.classList.add('br');
      text.append(s, ' ');
    });
    li.append(time, text);
    list.append(li);
  }
}

function status(msg: string, error = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
}

function refresh() {
  persist();
  try {
    renderList();
  } catch (e) {
    status((e as Error).message, true);
  }
}

// ---------- host actions ----------

async function run(preview: boolean) {
  if (!host) return status('Open this panel inside Premiere Pro or After Effects to generate captions.', true);
  if (!cues.length) return status('Load subtitles or transcribe a clip first (Source tab).', true);
  busy = true;
  cancelled = false;
  setBusy();
  try {
    validatePreset(current);
    await host.ensureLoaded();
    frame = await host.frameInfo();
    const st = style(), opts = options();
    const result = process();
    const caps = preview ? result.captions.slice(0, 5) : result.captions;
    const job = {
      ...buildHostJob(st, opts, result.layout, frame, preview),
      duration: caps[caps.length - 1].end + 1,
      premiere: host.app === 'premiere' ? { ...premiereFit(frame, result.layout), templatePath: '', font: st.font } : null,
    };
    if (job.premiere) {
      // A template the user rebuilt (in %APPDATA%) wins over the one shipped with the extension.
      const own = nodeRequire ? nodeRequire('path').join(userDataDir(), 'mogrt', job.premiere.templateFile) : '';
      job.premiere.templatePath = own && nodeRequire!('fs').existsSync(own) ? own : host.templateFolder() + '/' + job.premiere.templateFile;
    }
    // Premiere + Dynamic Link: After Effects builds the captions (over BridgeTalk), Premiere links them.
    const dl = host.app === 'premiere' && $('premiereOutput').value === 'dynamic-link';
    if (dl) {
      status('Opening the SubMotion project in After Effects… (starts After Effects if needed)');
      await host.aeCall('useSubMotionProject', { name: 'SubMotion_' + (frame.name ?? 'Sequence').replace(/[^\w-]+/g, '_') }, true);
      await host.aeCall('prepare', { ...job, standalone: true, fps: frame.fps ?? 30 });
    } else await host.prepare(job);
    const size = host.app === 'premiere' && !dl ? 10 : 20;
    for (let i = 0; i < caps.length && !cancelled; i += size) {
      const batch = caps.slice(i, i + size).map(toHostCaption);
      await (dl ? host.aeCall('createBatch', batch) : host.createBatch(batch));
      const done = Math.min(i + size, caps.length);
      $('progressBar').style.width = `${(done / caps.length) * 100}%`;
      status(`Generating${dl ? ' in After Effects' : ''}… ${done} / ${caps.length}`);
    }
    if (dl) {
      await host.aeCall('finish');
      status('Saving the After Effects project and linking it into Premiere…');
      const aep = await host.aeCall<string>('saveProject');
      await host.dlPlace(aep);
    } else await host.finish();
    const made = cancelled ? 'Cancelled — partial output kept (Delete generated removes it).' : `Done: ${caps.length} animated captions.`;
    status(preview ? `Preview: first ${caps.length} captions. Generate replaces them.` : made);
  } catch (e) {
    status((e as Error).message, true);
  } finally {
    busy = false;
    setBusy();
  }
}

/** Transcribes the selected clip/layer locally with Whisper; word timing comes out exact. */
/** First use: download what transcription still needs (asks once if it is big), straight from the publishers. */
async function ensureTools() {
  const fs = nodeRequire!('fs');
  const cfg = whisperConfig();
  const needModel = !cfg.modelPath || !fs.existsSync(cfg.modelPath);
  let hasFfmpeg = fs.existsSync(cfg.ffmpegPath);
  if (!hasFfmpeg && !/[\\/]/.test(cfg.ffmpegPath)) {
    try {
      nodeRequire!('child_process').execFileSync(cfg.ffmpegPath, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      hasFfmpeg = true;
    } catch { /* download if the command is not available on PATH */ }
  }
  const needFfmpeg = !hasFfmpeg;
  const needVad = !cfg.vadModelPath;
  if (!needModel && !needFfmpeg && !needVad) return;
  if (needModel || needFfmpeg) {
    const what = [needModel && 'the Whisper speech model (~550 MB, Hugging Face)', needFfmpeg && 'FFmpeg (~165 MB, GitHub)'].filter(Boolean).join(' and ');
    if (!confirm(`Transcription needs ${what}, downloaded once. Download now?`))
      throw new Error('Transcription needs these downloads. Click Transcribe again to download them.');
  }
  const job = downloadTools({ models: needModel, vad: needVad, ffmpeg: needFfmpeg }, (pct, label) => {
    $('progressBar').style.width = `${pct}%`;
    status(`Downloading ${label}… ${Math.round(pct)}%`);
  });
  cancelAction = job.cancel;
  await job.promise;
}

async function transcribeSelected() {
  if (!host || busy) return;
  busy = true;
  cancelled = false;
  setBusy();
  try {
    await host.ensureLoaded();
    const media = await host.mediaSource();
    await ensureTools();
    const lang = $<HTMLSelectElement>('language').value as 'auto' | 'id' | 'en';
    const job = transcribe(media, lang, whisperConfig(), (pct, phase) => {
      $('progressBar').style.width = `${pct}%`;
      status(`${phase}… ${Math.round(pct)}%`);
    });
    cancelAction = job.cancel;
    const { words } = await job.promise;
    cues = wordsToCues(placeWords(words, media));
    if (!cues.length) throw new Error('No speech found in the selected clip.');
    frame = await host.frameInfo();
    status(`Transcribed ${words.length} words from ${media.path.split(/[\\/]/).pop()}.`);
    refresh();
  } catch (e) {
    status((e as Error).message, true);
  } finally {
    cancelAction = null;
    busy = false;
    setBusy();
  }
}

function setBusy() {
  $('progress').hidden = !busy;
  if (!busy) $('progressBar').style.width = '0';
  for (const id of ['previewBtn', 'generateBtn', 'deleteBtn', 'templateBtn', 'fromLayers', 'transcribeBtn']) $<HTMLButtonElement>(id).disabled = busy;
}

async function hostAction(fn: () => Promise<string>) {
  if (!host || busy) return;
  try {
    await host.ensureLoaded();
    status(await fn());
  } catch (e) {
    status((e as Error).message, true);
  }
}

// ---------- wiring ----------

function init() {
  const saved = load();
  if (saved.preset && presets.list().some((p) => p.id === saved.preset)) presetId = saved.preset;
  try {
    current = saved.style ? validatePreset({ ...presets.get(presetId), ...saved.style }) : { ...presets.get(presetId) };
  } catch {
    current = { ...presets.get(presetId) }; // saved style from an older version
  }
  if (saved.language) $('language').value = saved.language;
  const opts = { ...DEFAULT_OPTIONS, ...saved.options };
  for (const k of OPTION_KEYS) $(k).checked = opts[k];
  cls = saved.cls === 1 ? 1 : 0;
  const found = detected();
  for (const k of WHISPER_KEYS) {
    // A saved path that no longer exists (moved install, old setup) falls back to detection.
    const mine = saved.whisper?.[k];
    $(k).value = mine && nodeRequire?.('fs').existsSync(mine) ? mine : '';
    $(k).placeholder = found[k] ? `auto: ${found[k]}` : k === 'modelPath' ? 'auto: downloaded on first use' : 'auto';
  }

  const hostName = host ? (host.app === 'aftereffects' ? 'After Effects' : 'Premiere Pro') : 'Browser preview';
  $('hostBadge').textContent = host ? (host.app === 'aftereffects' ? 'AE' : 'PR') : 'WEB';
  $('hostBadge').title = hostName;
  $('fromLayers').hidden = host?.app !== 'aftereffects';
  $('templateBtn').hidden = host?.app !== 'aftereffects';
  $('premiereOutputField').hidden = host?.app !== 'premiere';
  if (saved.premiereOutput) $('premiereOutput').value = saved.premiereOutput;
  const outputHint = () =>
    ($('premiereOutputHint').textContent = $('premiereOutput').value === 'dynamic-link'
      ? 'Full styling (fonts, shadow, glow). Needs After Effects; captions are saved in Documents\\SubMotion and edited in AE.'
      : 'Lightweight, edited in the Essential Graphics panel. Needs the SubMotion .mogrt templates.');
  outputHint();
  $('premiereOutput').addEventListener('change', () => {
    outputHint();
    persist();
  });
  $('transcribeBtn').hidden = $('whisperSetup').hidden = !host || !transcriptionAvailable();
  if (!host) status('Browser preview: text processing only. Open inside After Effects or Premiere to generate.');

  // Tabs and Normal/Emphasis switch.
  for (const b of document.querySelectorAll<HTMLElement>('.tabs [data-tab]')) b.onclick = () => showTab(b.dataset.tab!);
  for (const b of document.querySelectorAll<HTMLElement>('.classbar [data-class]'))
    b.onclick = () => {
      cls = Number(b.dataset.class) as 0 | 1;
      render();
      persist();
    };

  // data-key inputs write straight into the style.
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-key]')) {
    const write = () => {
      const k = el.dataset.key as keyof Preset;
      edit({ [k]: el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value });
    };
    el.addEventListener(el.type === 'range' ? 'input' : 'change', write);
  }
  $('clsIntensity').addEventListener('input', () => edit({ [ck('intensity')]: Number($('clsIntensity').value) }));
  $('clsColor').addEventListener('input', () => edit({ [ck('color')]: $('clsColor').value }));
  $('clsSize').addEventListener('change', () => edit(cls ? { emphasisSizeMul: Number($('clsSize').value) } : { fontSize: Number($('clsSize').value) }));
  $('fontSearch').addEventListener('input', () => {
    fontLimit = 60;
    renderFonts();
  });
  $('moreFonts').addEventListener('click', () => {
    fontLimit += 120;
    renderFonts();
  });
  for (const id of [...OPTION_KEYS, 'language']) $(id).addEventListener('change', refresh);

  $('file').addEventListener('change', async () => {
    const f = $('file').files?.[0];
    if (!f) return;
    try {
      cues = parseSubtitles(await f.text());
      if (!cues.length) throw new Error(`No subtitle cues found in ${f.name}.`);
      if (host) frame = await host.ensureLoaded().then(() => host.frameInfo());
      status(`Loaded ${f.name}`);
      refresh();
    } catch (e) {
      status((e as Error).message, true);
    }
    $('file').value = '';
  });
  $('fromLayers').addEventListener('click', () =>
    hostAction(async () => {
      cues = await host!.readSourceCaptions();
      frame = await host!.frameInfo();
      refresh();
      return `Loaded ${cues.length} cues from selected text layers.`;
    }),
  );
  $('previewBtn').addEventListener('click', () => run(true));
  $('generateBtn').addEventListener('click', () => run(false));
  $('transcribeBtn').addEventListener('click', transcribeSelected);
  $('cancelBtn').addEventListener('click', () => {
    cancelled = true;
    cancelAction?.();
    status('Cancelling…');
  });
  $('deleteBtn').addEventListener('click', () => hostAction(async () => `Removed ${await host!.deleteGenerated()} SubMotion item(s).`));
  $('templateBtn').addEventListener('click', () => {
    if (!confirm('Building the Premiere template saves your current After Effects project (After Effects requires it). Continue?')) return;
    hostAction(async () => {
      const st = style();
      const templates = TEMPLATES.map((t) => {
        const l = computeLayout(t, st, true);
        return { ...t, fontSize: TEMPLATE_FONT, positionYPct: l.positionYPct, maxWidthPct: (l.maxWidth / t.width) * 100 };
      });
      const base = buildHostJob(st, options(), computeLayout(TEMPLATES[0], st, true), TEMPLATES[0], false);
      const job = { ...base, style: { ...base.style, fontSize: TEMPLATE_FONT, strokeWidth: (st.strokeWidth * TEMPLATE_FONT) / st.fontSize } };
      if (!nodeRequire) throw new Error('Node.js is not enabled in this panel.');
      const fs = nodeRequire('fs');
      const written: string[] = [];
      for (const template of templates) {
        status(`Building ${template.file}…`);
        const { staged, file } = await host!.buildTemplate({ job, template });
        // After Effects exports asynchronously: wait for a complete zip. Never touch the staged file
        // while AE writes it (deleting it mid-write crashed AE); only copy it once complete.
        let done = false;
        for (let i = 0; i < 240 && !done; i++) {
          await new Promise((r) => setTimeout(r, 500));
          done = fs.existsSync(staged) && mogrtComplete(fs.readFileSync(staged));
        }
        if (!done) throw new Error(`After Effects did not finish exporting ${file}.`);
        await new Promise((r) => setTimeout(r, 1000)); // let AE close the file
        // Never into the extension folder: it is signed, and changing it stops the panel from loading.
        const dir = nodeRequire!('path').join(userDataDir(), 'mogrt');
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(staged, nodeRequire!('path').join(dir, file));
        written.push(file);
      }
      return `Premiere templates written to ${nodeRequire!('path').join(userDataDir(), 'mogrt')}:\n${written.join('\n')}`;
    });
  });

  showTab(saved.tab && document.querySelector(`[data-panel="${saved.tab}"]`) ? saved.tab : 'source');

  // Installed fonts (AE only); the fallback list stays for Premiere and the browser.
  if (host)
    host.ensureLoaded()
      .then(() => host.listFonts())
      .then((list) => {
        if (!list.length) return;
        fonts = list;
        setFonts(list);
        render();
      })
      .catch(() => {});
}

init();
