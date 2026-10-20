export type LangCode = 'id' | 'en';

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** One cue as it comes from SRT/VTT, host text layers or a transcript. Times in seconds. */
export interface SourceCaption {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words?: Word[]; // real per-word timing (transcription); otherwise timing is estimated
}

/** Internal word unit. A normalized number phrase ("lima puluh ribu") is ONE token ("50 RIBU"). */
export interface Token {
  text: string; // display text
  norm: string; // lowercase lookup form, punctuation stripped
  punct: string; // trailing punctuation from source
  start: number;
  end: number;
  weight: number; // spoken length, used for timing estimation
  seg: number; // index of source caption
  score: number; // keyword importance 0..100
  number?: 'plain' | 'big'; // big = has scale/currency/percent
  upper?: boolean; // ALL CAPS in source
  speaker?: string;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  score: number;
  emphasis: boolean;
  line: number;
}

export interface Caption {
  index: number;
  start: number;
  end: number;
  words: CaptionWord[];
  speaker?: string;
}

export type AnimName =
  | 'pop' | 'bounce' | 'fade' | 'slide-up' | 'scale'
  | 'punch' | 'shake' | 'typewriter' | 'blur-reveal' | 'snap';

export type VerticalPosition = 'upper' | 'middle' | 'lower';

export type EffectName = 'shadow' | 'hard-shadow' | 'glow' | 'outline';

/**
 * A caption style. Words come in two classes, Normal and Emphasis (keywords), each with its own
 * font, size, color, animation, intensity and effects.
 */
export interface Preset {
  id: string;
  name: string;
  // Normal words
  font: string; // PostScript name
  fallbackFonts: string[];
  fontSize: number; // px at 1080 short-side
  textColor: string;
  animation: AnimName;
  intensity: number; // 0..100, 50 = designed look
  normalEffects: EffectName[];
  // Emphasis words
  emphasisFont: string; // '' = same as font
  emphasisSizeMul: number;
  keywordColor: string;
  emphasisAnimation: AnimName;
  emphasisIntensity: number;
  emphasisEffects: EffectName[];
  // Shared typography
  tracking: number;
  lineSpacing: number; // multiple of the line's largest font size; < 1 overlaps lines
  wordSpacing: number; // em
  caseMode: 'as-is' | 'upper' | 'lower' | 'sentence';
  punctuation: 'keep' | 'minimal';
  activeColor: string;
  activeWordHighlight: boolean;
  strokeColor: string; // used by the 'outline' effect
  strokeWidth: number;
  // Motion control
  speed: number; // % (duration = 100 / speed)
  velocity: number; // 0..100 ease sharpness; 50 = cubic ease-out
  reveal: 'word' | 'caption';
  // Lines & words
  minWords: number;
  maxWords: number;
  maxChars: number;
  maxLines: number;
  maxWordsPerLine: number;
  maxWidthPct: number;
  position: VerticalPosition;
  safeMarginPct: number;
  // Emphasis selection
  keywordThreshold: number;
  maxKeywordsPerCaption: number;
  alwaysEmphasize: boolean; // every caption gets at least one emphasis word
  emphasisScope: 'word' | 'phrase'; // phrase = spread to adjacent content words
  stackEmphasis: boolean; // emphasis runs get their own line
  isolateKeywords: boolean;
  dramaticPunctuation: boolean;
}

export interface ProcessOptions {
  language: 'auto' | LangCode;
  smartLineBreak: boolean;
  highlightKeywords: boolean;
  animateKeywords: boolean;
  detectNumbers: boolean;
  autoResize: boolean;
  safeArea: boolean;
  wordHighlight: boolean;
  removeFillers: boolean;
  numberStyle: 'auto' | 'compact' | 'full';
}

export interface Frame {
  width: number;
  height: number;
}
