import type { AnimName, EffectName, Preset } from '../types.ts';

export const EFFECTS: EffectName[] = ['shadow', 'hard-shadow', 'glow', 'outline'];
import { ANIMATIONS } from '../animation-engine/index.ts';
import clean from '../../../presets/clean.json' with { type: 'json' };
import podcast from '../../../presets/podcast.json' with { type: 'json' };
import viral from '../../../presets/viral.json' with { type: 'json' };
import karaoke from '../../../presets/karaoke.json' with { type: 'json' };
import cinematic from '../../../presets/cinematic.json' with { type: 'json' };
import gaming from '../../../presets/gaming.json' with { type: 'json' };
import minimalTech from '../../../presets/minimal-tech.json' with { type: 'json' };
import punch from '../../../presets/punch.json' with { type: 'json' };
import stack from '../../../presets/stack.json' with { type: 'json' };

/** Every preset is a partial JSON merged over these defaults, so community presets stay tiny. */
export const DEFAULT_PRESET: Preset = {
  id: 'default', name: 'Default',
  font: 'Arial-BoldMT', fallbackFonts: ['Arial-BoldMT', 'ArialMT'],
  fontSize: 72, textColor: '#FFFFFF', animation: 'pop', intensity: 50, normalEffects: ['outline'],
  emphasisFont: '', emphasisSizeMul: 1.15, keywordColor: '#FFE500', emphasisAnimation: 'pop', emphasisIntensity: 50,
  emphasisEffects: ['outline'],
  tracking: 0, lineSpacing: 1.15, wordSpacing: 0.28, caseMode: 'sentence', punctuation: 'minimal',
  activeColor: '#FFE500', activeWordHighlight: false,
  strokeColor: '#000000', strokeWidth: 8,
  speed: 100, velocity: 50, reveal: 'word',
  minWords: 3, maxWords: 5, maxChars: 32, maxLines: 2, maxWordsPerLine: 6, maxWidthPct: 80,
  position: 'lower', safeMarginPct: 6,
  keywordThreshold: 60, maxKeywordsPerCaption: 2, alwaysEmphasize: false, emphasisScope: 'word',
  stackEmphasis: false, isolateKeywords: true, dramaticPunctuation: false,
};

const BUILT_IN = [stack, viral, clean, podcast, karaoke, cinematic, gaming, minimalTech, punch];
const COLOR = /^#[0-9a-f]{6}$/i;

/** Merges a partial preset over defaults and rejects anything the hosts can't apply. */
export function validatePreset(input: unknown): Preset {
  if (!input || typeof input !== 'object') throw new Error('Preset must be a JSON object');
  const p = { ...DEFAULT_PRESET, ...(input as Partial<Preset>) };
  const errors: string[] = [];
  if (!p.id || !/^[\w-]+$/.test(p.id)) errors.push('id must be letters, digits, - or _');
  if (!p.name) errors.push('name is required');
  for (const k of ['textColor', 'keywordColor', 'activeColor', 'strokeColor'] as const)
    if (!COLOR.test(p[k])) errors.push(`${k} must be #RRGGBB`);
  for (const k of ['animation', 'emphasisAnimation'] as const)
    if (!ANIMATIONS.includes(p[k] as AnimName)) errors.push(`${k} must be one of ${ANIMATIONS.join(', ')}`);
  for (const k of ['fontSize', 'emphasisSizeMul', 'minWords', 'maxWords', 'maxChars', 'maxLines', 'maxWordsPerLine', 'maxWidthPct', 'lineSpacing'] as const)
    if (!(typeof p[k] === 'number' && p[k] > 0)) errors.push(`${k} must be a positive number`);
  if (p.minWords > p.maxWords) errors.push('minWords must be <= maxWords');
  if (!['upper', 'middle', 'lower'].includes(p.position)) errors.push('position must be upper, middle or lower');
  for (const k of ['normalEffects', 'emphasisEffects'] as const)
    if (!Array.isArray(p[k]) || !p[k].every((e) => EFFECTS.includes(e))) errors.push(`${k} must be a list of ${EFFECTS.join(', ')}`);
  for (const k of ['intensity', 'emphasisIntensity', 'velocity'] as const)
    if (!(p[k] >= 0 && p[k] <= 100)) errors.push(`${k} must be 0..100`);
  if (errors.length) throw new Error(`Invalid preset "${p.name ?? '?'}": ${errors.join('; ')}`);
  return p;
}

export class PresetManager {
  private presets = new Map<string, Preset & { builtIn?: boolean }>();

  constructor(user: unknown[] = []) {
    for (const p of BUILT_IN) this.presets.set(p.id, { ...validatePreset(p), builtIn: true });
    for (const p of user) {
      try {
        this.save(p);
      } catch {
        /* skip broken user presets instead of breaking the panel */
      }
    }
  }

  list(): Preset[] {
    return [...this.presets.values()];
  }

  get(id: string): Preset {
    const p = this.presets.get(id);
    if (!p) throw new Error(`Unknown preset "${id}"`);
    return p;
  }

  /** Save/replace a user preset. Built-ins are read-only; duplicate them under a new id instead. */
  save(input: unknown): Preset {
    const p = validatePreset(input);
    if (this.presets.get(p.id)?.builtIn) throw new Error(`"${p.id}" is a built-in preset`);
    this.presets.set(p.id, p);
    return p;
  }

  remove(id: string): void {
    if (this.presets.get(id)?.builtIn) throw new Error(`"${id}" is a built-in preset`);
    this.presets.delete(id);
  }

  userPresets(): Preset[] {
    return this.list().filter((p) => !(p as { builtIn?: boolean }).builtIn);
  }

  export(id: string): string {
    const { builtIn: _, ...p } = this.get(id) as Preset & { builtIn?: boolean };
    return JSON.stringify(p, null, 2);
  }
}
