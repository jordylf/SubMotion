import type { Caption, Frame, Preset } from '../types.ts';

export interface Layout {
  fontSize: number; // px in this frame
  maxWidth: number; // px
  centerX: number;
  centerY: number; // vertical center of the caption block
  positionYPct: number; // centerY as % of frame height (for the Premiere template)
  safe: { top: number; bottom: number; left: number; right: number };
}

/** Rough glyph advance for bold sans fonts. The host re-measures real text and auto-fits. */
export function estimateWidth(text: string, fontSize: number, tracking = 0): number {
  return text.length * fontSize * (0.56 + tracking / 1000);
}

export function computeLayout(frame: Frame, style: Preset, safeArea: boolean): Layout {
  const short = Math.min(frame.width, frame.height);
  const fontSize = Math.round(style.fontSize * (short / 1080));
  const m = style.safeMarginPct / 100;
  const vertical = frame.height > frame.width;
  const safe = {
    top: frame.height * Math.max(m, safeArea && vertical ? 0.12 : 0),
    // Social apps put buttons/descriptions at the bottom and right of vertical video.
    bottom: frame.height * Math.max(m, safeArea && vertical ? 0.2 : 0),
    left: frame.width * m,
    right: frame.width * Math.max(m, safeArea && vertical ? 0.12 : 0),
  };
  const usable = frame.width - safe.left - safe.right;
  const maxWidth = Math.min(usable, (frame.width * style.maxWidthPct) / 100);
  const anchor = { upper: 0.25, middle: 0.5, lower: 0.72 }[style.position];
  const blockHalf = (fontSize * style.lineSpacing * style.maxLines) / 2;
  const centerY = clamp(frame.height * anchor, safe.top + blockHalf, frame.height - safe.bottom - blockHalf);
  return {
    fontSize,
    maxWidth,
    centerX: safe.left + usable / 2,
    centerY,
    positionYPct: (centerY / frame.height) * 100,
    safe,
  };
}

/**
 * Assigns line numbers. One line if it fits; otherwise the most balanced split into up to maxLines.
 * Returns the line index for each word.
 */
export function breakLines(widths: number[], space: number, maxWidth: number, maxLines: number, maxWordsPerLine = Infinity): number[] {
  const total = widths.reduce((a, b) => a + b, 0) + space * (widths.length - 1);
  const minLines = Math.ceil(widths.length / maxWordsPerLine);
  if ((total <= maxWidth && minLines <= 1) || widths.length < 2 || maxLines < 2) return widths.map(() => 0);
  let best = { cost: Infinity, lines: widths.map(() => 0) };
  for (let lines = Math.max(2, Math.min(minLines, maxLines)); lines <= Math.min(maxLines, widths.length); lines++) {
    const target = total / lines;
    const assign: number[] = [];
    let line = 0, cur = 0;
    widths.forEach((w, k) => {
      const remainingWords = widths.length - k;
      const remainingLines = lines - line - 1;
      const full = assign.filter((l) => l === line).length >= maxWordsPerLine;
      if (cur > 0 && remainingLines > 0 && (full || cur + space + w / 2 > target || remainingWords <= remainingLines)) {
        line++;
        cur = 0;
      }
      cur += (cur > 0 ? space : 0) + w;
      assign.push(line);
    });
    const widest = Math.max(...lineWidths(widths, assign, space));
    // Prefer fewer lines; any overflow is fixed by auto-resize, so penalize it rather than reject.
    const cost = widest + (widest > maxWidth ? (widest - maxWidth) * 3 : 0) + lines * 0.01;
    if (cost < best.cost) best = { cost, lines: assign };
    if (widest <= maxWidth) break;
  }
  return best.lines;
}

export function lineWidths(widths: number[], lines: number[], space: number): number[] {
  const out: number[] = [];
  widths.forEach((w, k) => (out[lines[k]] = out[lines[k]] === undefined ? w : out[lines[k]] + space + w));
  return out;
}

/** Fills word.line for every caption using estimated widths. */
export function layoutCaptions(captions: Caption[], layout: Layout, style: Preset, smart: boolean): Caption[] {
  for (const cap of captions) {
    const widths = cap.words.map((w) =>
      estimateWidth(w.text, layout.fontSize * (w.emphasis ? style.emphasisSizeMul : 1), style.tracking),
    );
    const space = layout.fontSize * style.wordSpacing;
    const lines =
      (style.stackEmphasis && stackLines(cap, style.maxLines, style.maxWordsPerLine)) ||
      (smart ? breakLines(widths, space, layout.maxWidth, style.maxLines, style.maxWordsPerLine) : widths.map(() => 0));
    cap.words.forEach((w, k) => (w.line = lines[k]));
  }
  return captions;
}

/**
 * CapComp-style stacking: each run of emphasis / normal words gets its own line(s); runs longer than
 * maxWordsPerLine are split evenly. Returns null (use balanced breaking) if it needs > maxLines.
 */
export function stackLines(cap: Caption, maxLines: number, maxWordsPerLine = Infinity): number[] | null {
  if (!cap.words.some((w) => w.emphasis) || cap.words.every((w) => w.emphasis)) return null;
  const lines: number[] = [];
  let line = -1;
  for (let k = 0; k < cap.words.length; ) {
    let end = k;
    while (end < cap.words.length && cap.words[end].emphasis === cap.words[k].emphasis) end++;
    const parts = Math.ceil((end - k) / maxWordsPerLine);
    for (let i = 0; i < end - k; i++) lines.push(line + 1 + Math.floor((i * parts) / (end - k)));
    line += parts;
    k = end;
  }
  return line < maxLines ? lines : null;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
