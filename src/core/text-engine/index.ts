import type { Caption, CaptionWord, Preset, Token } from '../types.ts';
import type { LanguagePack } from '../language-engine/index.ts';

export interface ChunkConfig {
  minWords: number;
  maxWords: number;
  maxChars: number;
  maxCps: number; // reading speed limit, characters per second
  maxGap: number; // a silence longer than this always ends a caption
  isolateKeywords: boolean;
}

const STRONG = 85;
const width = (toks: Token[], j: number, i: number) => {
  let c = i - j - 1;
  for (let k = j; k < i; k++) c += toks[k].text.length;
  return c;
};

/** Cost of making tokens[j..i) one caption, including the break after it. Lower is better. */
function chunkCost(toks: Token[], j: number, i: number, lang: LanguagePack, cfg: ChunkConfig): number {
  const w = i - j;
  if (w > 1 && width(toks, j, i) > cfg.maxChars) return Infinity;
  for (let k = j + 1; k < i; k++) if (toks[k].start - toks[k - 1].end > cfg.maxGap) return Infinity;

  const first = toks[j];
  const last = toks[i - 1];
  const next = toks[i];
  let cost = 1; // every caption costs something, so we don't over-split
  const isolatedKeyword = w === 1 && first.score >= STRONG;
  const dramaticBeat = w === 1 && lang.reveal.has(first.norm) && next !== undefined && next.score >= 80;
  if (w < cfg.minWords && !isolatedKeyword && !dramaticBeat) cost += (cfg.minWords - w) * 2.5;
  cost += 0.3 * Math.abs(w - Math.round((cfg.minWords + cfg.maxWords) / 2));
  if (cfg.isolateKeywords && w > 1) for (let k = j; k < i; k++) if (toks[k].score >= STRONG) cost += 2;
  for (let k = j; k < i - 1; k++) {
    if (/[.!?]/.test(toks[k].punct)) cost += 6; // sentence end inside caption
    if (toks[k + 1].seg !== toks[k].seg) cost += 4; // cues are phrases: prefer not to merge them
  }

  const dur = Math.max(0.05, last.end - first.start);
  if (width(toks, j, i) / dur > cfg.maxCps) cost += 1.5;

  if (next) {
    if (/[.!?]/.test(last.punct)) cost -= 4;
    else if (/[,;:]/.test(last.punct)) cost -= 2.5;
    if (next.start - last.end >= 0.25) cost -= 2;
    if (lang.contrast.has(next.norm)) cost -= 2.5;
    const setup = next.score >= STRONG && cfg.isolateKeywords; // "harganya cuma | 50 RIBU" is a deliberate beat
    if (setup) cost -= 1.5;
    if (lang.noEnd.has(last.norm) && !setup) cost += 3;
    if (lang.noStart.has(next.norm)) cost += 2.5;
    if (next.seg !== last.seg) cost -= 1.5;
  }
  return cost;
}

/** Optimal segmentation by dynamic programming: O(n * maxWords). Never splits inside a number phrase. */
export function chunkTokens(toks: Token[], lang: LanguagePack, cfg: ChunkConfig): Token[][] {
  const n = toks.length;
  const best = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - cfg.maxWords); j < i; j++) {
      if (best[j] === Infinity) continue;
      const c = best[j] + chunkCost(toks, j, i, lang, cfg);
      if (c < best[i]) {
        best[i] = c;
        from[i] = j;
      }
    }
  }
  const chunks: Token[][] = [];
  for (let i = n; i > 0; i = from[i]) chunks.unshift(toks.slice(from[i], i));
  return chunks;
}

/** Naive fallback when Smart Line Break is off: fixed word count, still respecting cue boundaries. */
export function chunkFixed(toks: Token[], maxWords: number): Token[][] {
  const chunks: Token[][] = [];
  for (const t of toks) {
    const cur = chunks[chunks.length - 1];
    if (cur && cur.length < maxWords && cur[0].seg === t.seg) cur.push(t);
    else chunks.push([t]);
  }
  return chunks;
}

/** Turns chunks into timed captions: case, punctuation style, emphasis picks, continuous timing. */
export function buildCaptions(chunks: Token[][], lang: LanguagePack, style: Preset, highlight: boolean): Caption[] {
  return chunks.map((chunk, ci) => {
    const next = chunks[ci + 1];
    const start = chunk[0].start;
    const spokenEnd = chunk[chunk.length - 1].end;
    // Hold until the next caption if the gap is short (no flicker); otherwise linger briefly.
    let end = spokenEnd + 0.4;
    if (next) end = next[0].start - spokenEnd < 0.6 ? next[0].start : Math.min(end, next[0].start);
    end = Math.max(end, Math.min(start + 0.3, next ? next[0].start : Infinity));

    const words = chunk.map((t, k) => {
      let text = t.number ? t.text : applyCase(t.text, style.caseMode, k === 0);
      text += style.punctuation === 'keep' ? t.punct : t.punct.replace(/[^!?…]/g, '').replace(/\.{3}/, '…');
      return { text, start: t.start, end: t.end, score: t.score, emphasis: false, line: 0 };
    });

    if (style.dramaticPunctuation && chunk.length === 1 && !chunk[0].punct) {
      const t = chunk[0];
      if (lang.reveal.has(t.norm) && next && next[0].score >= 80) words[0].text += '...';
      const prev = chunks[ci - 1];
      const endsSentence = !next || next[0].seg !== t.seg || /[.!?]/.test(t.punct);
      if (t.score >= STRONG && prev?.length === 1 && lang.reveal.has(prev[0].norm) && endsSentence) words[0].text += '?!';
    }

    if (highlight) pickEmphasis(chunk, words, lang, style);
    return { index: ci, start, end, words, ...(chunk[0].speaker ? { speaker: chunk[0].speaker } : {}) };
  });
}

/** Marks emphasis words: keywords above threshold, optionally a fallback pick and phrase spreading. */
function pickEmphasis(chunk: Token[], words: CaptionWord[], lang: LanguagePack, style: Preset): void {
  const content = (k: number) => !lang.common.has(chunk[k].norm) && !lang.hardFillers.has(chunk[k].norm) && chunk[k].norm.length > 1;
  let picks = [...words.keys()]
    .filter((k) => words[k].score >= style.keywordThreshold)
    .sort((a, b) => words[b].score - words[a].score)
    .slice(0, style.maxKeywordsPerCaption);
  if (!picks.length && style.alwaysEmphasize) {
    // Strongest content word; ties go to the longer (usually more meaningful) word.
    const best = [...words.keys()].filter(content).sort((a, b) => words[b].score - words[a].score || chunk[b].norm.length - chunk[a].norm.length)[0];
    if (best !== undefined) picks = [best];
  }
  for (const k of picks) words[k].emphasis = true;
  if (style.emphasisScope === 'phrase') {
    // Spread from words to neighbouring content words; numbers and contrast words stay on their own.
    const spreadable = (k: number) => content(k) && !chunk[k].number && !lang.contrast.has(chunk[k].norm);
    for (const k of picks.filter(spreadable)) {
      for (let j = k - 1; j >= 0 && spreadable(j) && !words[j].emphasis; j--) words[j].emphasis = true;
      for (let j = k + 1; j < words.length && spreadable(j) && !words[j].emphasis; j++) words[j].emphasis = true;
    }
  }
}

function applyCase(text: string, mode: Preset['caseMode'], first: boolean): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'sentence' && first) return text.charAt(0).toUpperCase() + text.slice(1);
  return text;
}
