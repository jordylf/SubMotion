import type { SourceCaption } from '../types.ts';

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

const sec = (h: string | undefined, m: string, s: string, ms: string) =>
  (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Parses SRT or WebVTT. Strips markup, keeps VTT <v Speaker> voice tags as speaker. */
export function parseSubtitles(input: string): SourceCaption[] {
  const out: SourceCaption[] = [];
  const blocks = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => TIME.test(l));
    if (ti < 0) continue; // header, NOTE, STYLE, or garbage
    const m = TIME.exec(lines[ti])!;
    let raw = lines.slice(ti + 1).join(' ');
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw);
    raw = raw.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    out.push({ start, end, text: raw, ...(voice ? { speaker: voice[1].trim() } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}
