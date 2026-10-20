import type { LangCode, SourceCaption, Token } from '../types.ts';
import { indonesian } from '../../languages/id-ID/index.ts';
import { english } from '../../languages/en-US/index.ts';

export interface NumberMatch {
  len: number; // tokens consumed (including unit word)
  value: number;
  scale: number; // largest scale word spoken (1000, 1e6...), 0 if none
  unit: '' | '%' | 'currency';
  digits: boolean; // started from a digit token like "50" or "50rb"
}

export interface LanguagePack {
  code: LangCode;
  name: string;
  common: Set<string>; // high-frequency words: detection + zero keyword score
  hardFillers: Set<string>; // pure hesitation sounds, always removable
  softFillers: string[][]; // discourse fillers, removed only when comma-isolated
  noEnd: Set<string>; // a caption should not end on these
  noStart: Set<string>; // particles that cling to the previous word
  contrast: Set<string>;
  reveal: Set<string>; // "ternyata", "actually": dramatic beat before a reveal
  emotional: Set<string>;
  strongVerbs: Set<string>;
  decimalSep: ',' | '.';
  parseNumber(norms: string[], i: number): NumberMatch | null;
  formatNumber(m: NumberMatch, style: 'auto' | 'compact' | 'full'): string;
}

export const LANGUAGES: Record<LangCode, LanguagePack> = { id: indonesian, en: english };

const EDGE_PUNCT = /^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu;

export function normWord(raw: string): string {
  return raw.toLowerCase().replace(EDGE_PUNCT, '');
}

/** Picks the language whose common words appear most. Defaults to English. */
export function detectLanguage(texts: string[]): { code: LangCode; confidence: number } {
  const hits: Record<LangCode, number> = { id: 0, en: 0 };
  let seen = 0;
  for (const t of texts) {
    for (const w of t.split(/\s+/)) {
      const n = normWord(w);
      if (!n) continue;
      for (const code of Object.keys(hits) as LangCode[]) if (LANGUAGES[code].common.has(n)) hits[code]++;
      if (++seen > 3000) break;
    }
    if (seen > 3000) break;
  }
  const total = hits.id + hits.en;
  const code: LangCode = hits.id > hits.en ? 'id' : 'en';
  return { code, confidence: total ? hits[code] / total : 0 };
}

/** Splits cues into tokens with per-word timing (real if the cue has words, else estimated). */
export function tokenize(cues: SourceCaption[]): Token[] {
  const out: Token[] = [];
  cues.forEach((cue, seg) => {
    const timed = cue.words?.filter((w) => normWord(w.text) || /[\p{N}]/u.test(w.text));
    const words = timed ? timed.map((w) => w.text) : cue.text.split(/\s+/).filter((w) => normWord(w) || /[\p{N}]/u.test(w));
    const weights = words.map((w) => normWord(w).length + 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let t = cue.start;
    const dur = cue.end - cue.start;
    words.forEach((raw, i) => {
      // Real word timing when transcribed; otherwise split the cue proportionally to word length.
      const d = timed ? timed[i].end - timed[i].start : (dur * weights[i]) / total;
      if (timed) t = timed[i].start;
      const norm = normWord(raw);
      const punct = (/[^\p{L}\p{N}%]+$/u.exec(raw)?.[0] ?? '').replace(/["'”’)\]]/g, '');
      out.push({
        text: raw.replace(/[^\p{L}\p{N}%]+$/u, '').replace(/^["'“‘(\[]+/, ''),
        norm,
        punct,
        start: t,
        end: t + d,
        weight: weights[i],
        seg,
        score: 0,
        upper: raw.length > 1 && /\p{L}/u.test(raw) && raw === raw.toUpperCase(),
        ...(cue.speaker ? { speaker: cue.speaker } : {}),
      });
      t += d;
    });
  });
  return out;
}

/** Removes the token range [i, i+len) and hands sentence punctuation back to the previous word. */
function dropRange(tokens: Token[], i: number, len: number): void {
  const last = tokens[i + len - 1];
  const prev = tokens[i - 1];
  if (prev && prev.seg === last.seg && /[.!?]/.test(last.punct)) prev.punct = last.punct;
  if (prev && prev.seg === last.seg) prev.end = last.end; // keep speech time continuous
  tokens.splice(i, len);
}

/**
 * Conservative filler removal: hesitation sounds always go; discourse fillers ("kayak", "you know")
 * only when isolated by commas or at a cue edge before a comma, so meaning is preserved.
 */
export function removeFillers(tokens: Token[], lang: LanguagePack): Token[] {
  const out = tokens.slice();
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (lang.hardFillers.has(t.norm)) {
      dropRange(out, i--, 1);
      continue;
    }
    for (const phrase of lang.softFillers) {
      const len = phrase.length;
      if (!phrase.every((w, k) => out[i + k]?.norm === w && out[i + k].seg === t.seg)) continue;
      const prev = out[i - 1];
      const last = out[i + len - 1];
      const openIsolated = !prev || prev.seg !== t.seg || /[,;]/.test(prev.punct);
      const closeIsolated = /[,;.!?]/.test(last.punct);
      if (openIsolated && closeIsolated) {
        dropRange(out, i--, len);
        break;
      }
    }
  }
  return out;
}

/** Merges spoken number phrases into single tokens ("lima puluh ribu" -> "50 RIBU"). */
export function normalizeNumbers(tokens: Token[], lang: LanguagePack, style: 'auto' | 'compact' | 'full'): Token[] {
  const out: Token[] = [];
  const norms = tokens.map((t) => t.norm);
  for (let i = 0; i < tokens.length; i++) {
    const m = lang.parseNumber(norms, i);
    // Phrases may not cross cue boundaries.
    const len = m ? Math.min(m.len, tokens.slice(i, i + m.len).findIndex((t) => t.seg !== tokens[i].seg) + 1 || m.len) : 0;
    if (!m || len !== m.len) {
      out.push(tokens[i]);
      continue;
    }
    const big = m.scale >= 1000 || m.unit !== '';
    if (!big && m.digits) {
      out.push({ ...tokens[i], number: 'plain' }); // "2020" stays as written
      continue;
    }
    if (!big && m.value < 10) {
      out.push(tokens[i]); // "satu hal", "one of them": leave words alone
      continue;
    }
    const span = tokens.slice(i, i + len);
    const last = span[span.length - 1];
    out.push({
      ...span[0],
      text: lang.formatNumber(m, style),
      norm: span.map((t) => t.norm).join(' '),
      punct: last.punct,
      end: last.end,
      weight: span.reduce((a, t) => a + t.weight, 0),
      number: big ? 'big' : 'plain',
    });
    i += len - 1;
  }
  return out;
}
