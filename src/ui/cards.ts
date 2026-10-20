import type { AnimName, EffectName, Preset } from '../core/types.ts';

/** [postScriptName, family, style] — from AE's app.fonts, or the fallback list below. */
export type FontEntry = [string, string, string];

/** Used when the host can't enumerate fonts (Premiere, browser preview). */
export const FALLBACK_FONTS: FontEntry[] = [
  ['Arial-BoldMT', 'Arial', 'Bold'], ['Arial-Black', 'Arial Black', 'Regular'], ['Impact', 'Impact', 'Regular'],
  ['Georgia', 'Georgia', 'Regular'], ['Georgia-Bold', 'Georgia', 'Bold'], ['SegoeUI-Semibold', 'Segoe UI', 'Semibold'],
  ['SegoeUI-Bold', 'Segoe UI', 'Bold'], ['Verdana-Bold', 'Verdana', 'Bold'], ['Tahoma-Bold', 'Tahoma', 'Bold'],
  ['TrebuchetMS-Bold', 'Trebuchet MS', 'Bold'], ['Calibri-Bold', 'Calibri', 'Bold'],
  ['Poppins-Bold', 'Poppins', 'Bold'], ['Poppins-ExtraBold', 'Poppins', 'ExtraBold'],
  ['Montserrat-Bold', 'Montserrat', 'Bold'], ['Montserrat-ExtraBold', 'Montserrat', 'ExtraBold'],
];

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi ?bold|demi/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy|super/i, 900], [/bold/i, 700],
];

let index = new Map<string, FontEntry>(FALLBACK_FONTS.map((f) => [f[0], f]));
export function setFonts(fonts: FontEntry[]) {
  index = new Map(fonts.map((f) => [f[0], f]));
}

/** CSS that approximates a PostScript font in the panel (family + weight + italic). */
export function fontCss(ps: string): Partial<CSSStyleDeclaration> {
  const [, family, style] = index.get(ps) ?? [ps, ps.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2'), ps.split('-')[1] ?? ''];
  return {
    fontFamily: `"${family}", "Segoe UI", sans-serif`,
    fontWeight: String(WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400),
    fontStyle: /italic|oblique/i.test(style) ? 'italic' : 'normal',
  };
}

export const EFFECT_INFO: Record<EffectName, string> = {
  shadow: 'Soft Shadow',
  'hard-shadow': 'Hard Shadow',
  glow: 'Glow',
  outline: 'Outline',
};

export function effectCss(effects: EffectName[], color: string, strokeColor: string): Partial<CSSStyleDeclaration> {
  const shadows: string[] = [];
  // Outline as 8 hard shadows: -webkit-text-stroke would eat into the glyphs (no paint-order in CEP's Chromium).
  if (effects.includes('outline'))
    for (let a = 0; a < 8; a++) shadows.push(`${(Math.cos((a * Math.PI) / 4) * 0.05).toFixed(3)}em ${(Math.sin((a * Math.PI) / 4) * 0.05).toFixed(3)}em 0 ${strokeColor}`);
  if (effects.includes('glow')) shadows.push(`0 0 .3em ${color}`, `0 0 .08em ${color}`);
  if (effects.includes('hard-shadow')) shadows.push('.07em .07em 0 #000');
  if (effects.includes('shadow')) shadows.push('0 .06em .22em rgba(0,0,0,.9)');
  return { textShadow: shadows.join(', ') || 'none' };
}

/** Style a sample element like a word of the given class (0 normal, 1 emphasis). */
export function styleSample(el: HTMLElement, p: Preset, cls: 0 | 1, effects = cls ? p.emphasisEffects : p.normalEffects) {
  const color = cls ? p.keywordColor : p.textColor;
  Object.assign(el.style, fontCss(cls && p.emphasisFont ? p.emphasisFont : p.font), effectCss(effects, color, p.strokeColor), { color });
}

const applyCase = (t: string, mode: Preset['caseMode']) =>
  mode === 'upper' ? t.toUpperCase() : mode === 'lower' ? t.toLowerCase() : t;

export function card(label: string, stageClass = ''): { el: HTMLButtonElement; stage: HTMLDivElement } {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  const stage = document.createElement('div');
  stage.className = `stage ${stageClass}`;
  const tick = document.createElement('span');
  tick.className = 'tick';
  const lab = document.createElement('span');
  lab.className = 'label';
  const b = document.createElement('b');
  b.textContent = label;
  lab.append(b);
  el.append(tick, stage, lab);
  return { el, stage };
}

/** Two-line caption mock in the preset's own look: a normal line over an emphasis line. */
export function presetPreview(p: Preset): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mini';
  const normal = document.createElement('span');
  normal.textContent = applyCase('the price was', p.caseMode);
  styleSample(normal, p, 0);
  normal.style.fontSize = '15px';
  const emph = document.createElement('span');
  emph.textContent = applyCase('50 RIBU', p.caseMode === 'lower' ? 'as-is' : p.caseMode);
  styleSample(emph, p, 1);
  emph.style.fontSize = `${Math.round(15 * p.emphasisSizeMul)}px`;
  box.append(normal, emph);
  return box;
}

export function sample(text: string, anim?: AnimName): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'sample';
  s.textContent = text;
  if (anim) s.dataset.anim = anim;
  return s;
}
