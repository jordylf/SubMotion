import type { SourceCaption, Word } from '../types.ts';

/** Where a piece of media sits on the host timeline: timelineTime = offset + mediaTime * rate. */
export interface MediaPlacement {
  path: string;
  offset: number;
  rate: number;
  from: number; // visible range on the timeline (trimmed clip / layer in-out)
  to: number;
}

interface WhisperSegment {
  offsets: { from: number; to: number }; // ms
  text: string;
}

/**
 * Reads whisper.cpp `-oj` output produced with `-ml 1 -sow` (one segment per word).
 * Punctuation-only segments are glued onto the previous word.
 */
export function parseWhisperJson(json: string): { language: string; words: Word[] } {
  const data = JSON.parse(json) as { result?: { language?: string }; transcription?: WhisperSegment[] };
  const words: Word[] = [];
  for (const seg of data.transcription ?? []) {
    const text = seg.text.trim();
    if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // [Music], (laughs)
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const prev = words[words.length - 1];
    if (prev && (!/[\p{L}\p{N}]/u.test(text) || !/^\s/.test(seg.text))) {
      // punctuation, or a sub-word piece without a leading space ("harga" + "nya")
      prev.text += text;
      prev.end = Math.max(prev.end, end);
      continue;
    }
    words.push({ text, start, end: Math.max(end, start + 0.01) });
  }
  return { language: data.result?.language ?? '', words };
}

/** Moves words from media time to timeline time and drops words outside the trimmed range. */
export function placeWords(words: Word[], p: MediaPlacement): Word[] {
  return words
    .map((w) => ({ text: w.text, start: p.offset + w.start * p.rate, end: p.offset + w.end * p.rate }))
    .filter((w) => w.end > p.from && w.start < p.to);
}

/**
 * Groups word-timed speech into cues at sentence ends and pauses. The splitter makes the final
 * captions; cues only bound where a caption may never span (pauses) and keep number phrases whole.
 */
export function wordsToCues(words: Word[], maxGap = 0.6, maxWords = 40): SourceCaption[] {
  const cues: SourceCaption[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev && (w.start - prev.end > maxGap || /[.!?]$/.test(prev.text) || cur.length >= maxWords)) flush();
    cur.push(w);
  });
  flush();
  return cues;
}

const srtTime = (t: number) => {
  const ms = Math.round(t * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** SRT export so a transcript can also feed Premiere's native caption track. */
export function cuesToSrt(cues: SourceCaption[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}
