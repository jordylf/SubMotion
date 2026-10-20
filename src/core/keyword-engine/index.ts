import type { Token } from '../types.ts';
import type { LanguagePack } from '../language-engine/index.ts';

/**
 * Rule-based importance score 0..100 per token. Mutates token.score.
 * ponytail: lexicon + heuristics; the AI semantic engine (Phase 3) can overwrite scores after this pass.
 */
export function scoreKeywords(tokens: Token[], lang: LanguagePack): Token[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.norm, (counts.get(t.norm) ?? 0) + 1);

  tokens.forEach((t, i) => {
    const content = !lang.common.has(t.norm) && !lang.hardFillers.has(t.norm) && t.norm.length > 1;
    let s = 0;
    if (t.number === 'big') s = 95;
    else if (t.number === 'plain') s = 80;
    if (lang.emotional.has(t.norm)) s = Math.max(s, 70);
    if (lang.strongVerbs.has(t.norm)) s = Math.max(s, 50);
    if (lang.contrast.has(t.norm)) s = Math.max(s, 30);
    if (content) {
      if (t.norm.length >= 8) s += 10; // long words tend to carry meaning
      if (/[.!?]/.test(t.punct)) s += 10; // sentence-final emphasis
      if ((counts.get(t.norm) ?? 0) >= 2 && nearbyRepeat(tokens, i)) s += 15;
    }
    if (t.upper) s += 30;
    if (t.punct.includes('!')) s += 20;
    else if (t.punct.includes('?')) s += 10;
    t.score = Math.max(0, Math.min(100, s));
  });
  return tokens;
}

function nearbyRepeat(tokens: Token[], i: number): boolean {
  for (let k = Math.max(0, i - 12); k < Math.min(tokens.length, i + 13); k++)
    if (k !== i && tokens[k].norm === tokens[i].norm) return true;
  return false;
}
