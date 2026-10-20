import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuesToSrt, parseWhisperJson, placeWords, wordsToCues } from '../src/core/transcript/index.ts';
import { parseSubtitles } from '../src/core/subtitle-parser/index.ts';
import { DEFAULT_OPTIONS, processSubtitles } from '../src/core/pipeline.ts';
import { PresetManager } from '../src/core/preset-engine/index.ts';

const seg = (from: number, to: number, text: string) => ({ offsets: { from, to }, text });
const whisper = JSON.stringify({
  result: { language: 'id' },
  transcription: [
    seg(0, 200, ' gue'), seg(200, 450, ' kira'), seg(450, 800, ' harga'), seg(800, 950, 'nya'),
    seg(950, 1200, ' lima'), seg(1200, 1450, ' puluh'), seg(1450, 1800, ' ribu'), seg(1800, 1800, '.'),
    seg(1900, 2000, ' [Music]'), seg(3000, 3400, ' ternyata'),
  ],
});

test('parses whisper.cpp word JSON, gluing sub-words and punctuation', () => {
  const { language, words } = parseWhisperJson(whisper);
  assert.equal(language, 'id');
  assert.deepEqual(words.map((w) => w.text), ['gue', 'kira', 'harganya', 'lima', 'puluh', 'ribu.', 'ternyata']);
  assert.equal(words[2].end, 0.95);
});

test('maps media time to timeline time and trims to the clip range', () => {
  const words = [{ text: 'a', start: 1, end: 2 }, { text: 'b', start: 10, end: 11 }];
  assert.deepEqual(placeWords(words, { path: '', offset: 5, rate: 1, from: 0, to: 8 }), [{ text: 'a', start: 6, end: 7 }]);
  assert.deepEqual(placeWords(words, { path: '', offset: 0, rate: 0.5, from: 0, to: 100 })[1], { text: 'b', start: 5, end: 5.5 });
});

test('word-timed cues split at sentence ends and pauses and keep exact timing through the pipeline', () => {
  const cues = wordsToCues(parseWhisperJson(whisper).words);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'gue kira harganya lima puluh ribu.');
  const caps = processSubtitles(cues, new PresetManager().get('viral'), { ...DEFAULT_OPTIONS, language: 'id' }, { width: 1080, height: 1920 }).captions;
  const ribu = caps.flatMap((c) => c.words).find((w) => w.text.startsWith('50 RIBU'))!;
  assert.equal(ribu.start, 0.95); // starts exactly when "lima" is spoken
  assert.equal(ribu.end, 1.8);
});

test('SRT export round-trips', () => {
  const cues = wordsToCues(parseWhisperJson(whisper).words);
  assert.deepEqual(parseSubtitles(cuesToSrt(cues)).map((c) => c.text), cues.map((c) => c.text));
});
