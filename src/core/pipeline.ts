import type { Caption, Frame, LangCode, Preset, ProcessOptions, SourceCaption } from './types.ts';
import { LANGUAGES, detectLanguage, normalizeNumbers, removeFillers, tokenize } from './language-engine/index.ts';
import { scoreKeywords } from './keyword-engine/index.ts';
import { buildCaptions, chunkFixed, chunkTokens } from './text-engine/index.ts';
import { computeLayout, layoutCaptions, type Layout } from './layout-engine/index.ts';
import { ANIMATION_LABELS, aeWordExpressions, animIndex, mogrtExpressions } from './animation-engine/index.ts';

export const DEFAULT_OPTIONS: ProcessOptions = {
  language: 'auto',
  smartLineBreak: true,
  highlightKeywords: true,
  animateKeywords: true,
  detectNumbers: true,
  autoResize: true,
  safeArea: true,
  wordHighlight: false,
  removeFillers: false,
  numberStyle: 'auto',
};

export interface ProcessResult {
  language: LangCode;
  confidence: number;
  captions: Caption[];
  layout: Layout;
}

/** SubtitleProcessor: cues in, timed + emphasized + laid-out captions out. Pure and host-independent. */
export function processSubtitles(cues: SourceCaption[], style: Preset, opts: ProcessOptions, frame: Frame): ProcessResult {
  const det = opts.language === 'auto' ? detectLanguage(cues.map((c) => c.text)) : { code: opts.language, confidence: 1 };
  const lang = LANGUAGES[det.code];
  let toks = tokenize(cues);
  if (opts.removeFillers) toks = removeFillers(toks, lang);
  if (opts.detectNumbers) toks = normalizeNumbers(toks, lang, opts.numberStyle);
  scoreKeywords(toks, lang);
  const chunks = opts.smartLineBreak
    ? chunkTokens(toks, lang, {
        minWords: style.minWords,
        maxWords: style.maxWords,
        maxChars: style.maxChars,
        maxCps: 20,
        maxGap: 0.8,
        isolateKeywords: style.isolateKeywords,
      })
    : chunkFixed(toks, style.maxWords);
  const captions = buildCaptions(chunks, lang, style, opts.highlightKeywords);
  const layout = computeLayout(frame, style, opts.safeArea);
  layoutCaptions(captions, layout, style, opts.smartLineBreak);
  return { language: det.code, confidence: det.confidence, captions, layout };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000);

/** Compact, host-ready caption. AE uses words; Premiere uses text/kw/times (whitespace-word indexed). */
export interface HostCaption {
  i: number;
  s: number;
  e: number;
  words: [text: string, start: number, end: number, emphasis: 0 | 1, line: number][];
  text: string; // lines joined with \r
  kw: string; // 1-based whitespace-word indices, e.g. "3,4"
  times: string; // per whitespace-word start offset from caption start
}

export function toHostCaption(c: Caption): HostCaption {
  const lines: string[] = [];
  const kw: number[] = [];
  const times: string[] = [];
  for (const w of c.words) {
    lines[w.line] = lines[w.line] ? lines[w.line] + ' ' + w.text : w.text;
    for (const _ of w.text.split(' ')) {
      times.push((Math.round((w.start - c.start) * 1000) / 1000).toString());
      if (w.emphasis) kw.push(times.length);
    }
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    i: c.index,
    s: r3(c.start),
    e: r3(c.end),
    words: c.words.map((w) => [w.text, r3(w.start - c.start), r3(w.end - c.start), w.emphasis ? 1 : 0, w.line]),
    text: lines.filter(Boolean).join('\r'),
    kw: kw.join(','),
    times: times.join(','),
  };
}

const clamp01 = (v: number) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;

/** "Speed" slider: 50 = normal, every 25 doubles/halves (25% .. 400%). */
export const speedToSlider = (speedPct: number) => clamp01(50 + 25 * Math.log2(Math.max(speedPct, 1) / 100));

/** Everything the host needs once per run (style, controls, expressions). Captions are sent in batches. */
export function buildHostJob(style: Preset, opts: ProcessOptions, layout: Layout, frame: Frame, preview: boolean) {
  return {
    preview,
    frame,
    style: {
      font: style.font,
      fallbackFonts: style.fallbackFonts,
      fontSize: layout.fontSize,
      emphasisFont: style.emphasisFont,
      emphasisSizeMul: style.emphasisSizeMul,
      tracking: style.tracking,
      lineSpacing: style.lineSpacing,
      wordSpacing: style.wordSpacing,
      textColor: rgb(style.textColor),
      strokeColor: rgb(style.strokeColor),
      strokeWidth: (style.strokeWidth * layout.fontSize) / style.fontSize,
      // Effects per word class: [normal, emphasis]
      effects: [style.normalEffects, style.emphasisEffects],
      reveal: style.reveal,
    },
    layout: {
      centerX: layout.centerX,
      centerY: layout.centerY,
      maxWidth: layout.maxWidth,
      positionYPct: layout.positionYPct,
      maxWidthPct: (layout.maxWidth / frame.width) * 100,
      autoResize: opts.autoResize,
    },
    controls: {
      labels: ANIMATION_LABELS,
      animation: animIndex(style.animation),
      emphasisAnimation: animIndex(style.emphasisAnimation),
      animateEmphasis: opts.animateKeywords,
      intensity: style.intensity,
      emphasisIntensity: style.emphasisIntensity,
      // Exposed .mogrt sliders are clamped to 0..100 in Premiere, so every control lives in that range.
      emphasisSizeExtra: clamp01((style.emphasisSizeMul - 1) * 100), // template only (AE sets real font sizes)
      speed: speedToSlider(style.speed),
      velocity: style.velocity,
      normalColor: rgb(style.textColor),
      emphasisColor: rgb(opts.highlightKeywords ? style.keywordColor : style.textColor),
      activeColor: rgb(style.activeColor),
      activeWordHighlight: opts.wordHighlight || style.activeWordHighlight,
    },
    expr: aeWordExpressions('SubMotion Captions'),
    mogrtExpr: mogrtExpressions(),
  };
}
export type HostJob = ReturnType<typeof buildHostJob>;

/** The .mogrt templates SubMotion builds in After Effects (font size 100px inside the template). */
export const TEMPLATE_FONT = 200; // big base size keeps "Size %" well inside 0..100
export const TEMPLATES = [
  { width: 1080, height: 1920, file: 'SubMotion_Caption_1080x1920.mogrt' },
  { width: 1920, height: 1080, file: 'SubMotion_Caption_1920x1080.mogrt' },
];

/**
 * Maps a layout computed for the sequence frame onto the fixed-size template: Premiere places a
 * .mogrt unscaled at sequence center, so we pick the matching orientation, scale it with Motion,
 * and express position/size/width in template units.
 */
export function premiereFit(frame: Frame, layout: Layout) {
  const tpl = frame.height > frame.width ? TEMPLATES[0] : TEMPLATES[1];
  const scale = frame.height > frame.width ? frame.width / tpl.width : frame.height / tpl.height;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    templateFile: tpl.file,
    motionScale: r2(scale * 100),
    positionYPct: r2(50 + ((layout.centerY - frame.height / 2) / (tpl.height * scale)) * 100),
    maxWidthPct: r2((layout.maxWidth / (tpl.width * scale)) * 100),
    sizePct: r2((layout.fontSize / (TEMPLATE_FONT * scale)) * 100),
  };
}

/**
 * True once a .mogrt (zip) is completely written: After Effects exports asynchronously, and a
 * half-written file has no end-of-central-directory record yet (or only definition.json in it).
 */
export function mogrtComplete(buf: Uint8Array): boolean {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const entries = buf[i + 10] | (buf[i + 11] << 8);
      return entries >= 2;
    }
  }
  return false;
}
