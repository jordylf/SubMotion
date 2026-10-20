import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles } from '../src/core/subtitle-parser/index.ts';
import { LANGUAGES, detectLanguage, normalizeNumbers, removeFillers, tokenize } from '../src/core/language-engine/index.ts';
import { scoreKeywords } from '../src/core/keyword-engine/index.ts';
import { breakLines, computeLayout } from '../src/core/layout-engine/index.ts';
import { DEFAULT_PRESET, PresetManager, validatePreset } from '../src/core/preset-engine/index.ts';
import { ENV_FN, ANIMATIONS } from '../src/core/animation-engine/index.ts';
import { DEFAULT_OPTIONS, processSubtitles, toHostCaption } from '../src/core/pipeline.ts';
import type { LangCode } from '../src/core/types.ts';

const cue = (text: string) => [{ start: 0, end: 4, text }];
const numbers = (text: string, lang: LangCode, style: 'auto' | 'compact' | 'full' = 'auto') =>
  normalizeNumbers(tokenize(cue(text)), LANGUAGES[lang], style).map((t) => t.text).join(' ');
const split = (text: string, preset = 'viral', lang: LangCode | 'auto' = 'auto') =>
  processSubtitles(cue(text), new PresetManager().get(preset), { ...DEFAULT_OPTIONS, language: lang }, { width: 1080, height: 1920 })
    .captions.map((c) => c.words.map((w) => w.text).join(' '));

test('parses SRT and VTT, strips markup, keeps speakers', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Halo</i> semua\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nlagi\r\n';
  assert.deepEqual(parseSubtitles(srt), [
    { start: 1, end: 2.5, text: 'Halo semua' },
    { start: 3, end: 4, text: 'lagi' },
  ]);
  const vtt = 'WEBVTT\n\nNOTE hi\n\n00:01.200 --> 00:02.000\n<v Budi>Apa kabar</v>\n';
  assert.deepEqual(parseSubtitles(vtt), [{ start: 1.2, end: 2, text: 'Apa kabar', speaker: 'Budi' }]);
});

test('Indonesian number normalization', () => {
  assert.equal(numbers('lima puluh ribu', 'id'), '50 RIBU');
  assert.equal(numbers('dua juta', 'id'), '2 JUTA');
  assert.equal(numbers('satu koma lima juta', 'id'), '1,5 JUTA');
  assert.equal(numbers('lima juta rupiah', 'id'), 'Rp5 JUTA');
  assert.equal(numbers('seratus dua puluh lima ribu', 'id'), '125 RIBU');
  assert.equal(numbers('dua puluh persen', 'id'), '20%');
  assert.equal(numbers('tiga miliar', 'id'), '3 MILIAR');
  assert.equal(numbers('lima puluh ribu', 'id', 'full'), '50.000');
  assert.equal(numbers('50rb', 'id'), '50 RIBU');
  // conservative: small standalone numbers and ranges stay words, years stay as written
  assert.equal(numbers('satu hal', 'id'), 'satu hal');
  assert.equal(numbers('dua tiga hari', 'id'), 'dua tiga hari');
  assert.equal(numbers('tahun 2020', 'id'), 'tahun 2020');
});

test('English number normalization', () => {
  assert.equal(numbers('five thousand dollars', 'en'), '$5,000');
  assert.equal(numbers('twenty percent', 'en'), '20%');
  assert.equal(numbers('two million', 'en'), '2 MILLION');
  assert.equal(numbers('one point five million dollars', 'en'), '$1.5 MILLION');
  assert.equal(numbers('one hundred and five', 'en'), '105');
  assert.equal(numbers('a thousand', 'en'), '1,000');
  assert.equal(numbers('one of them', 'en'), 'one of them');
});

test('splits the Indonesian reveal example from the spec', () => {
  assert.deepEqual(split('gue kira harganya cuma lima puluh ribu ternyata lima juta'), [
    'Gue kira harganya cuma', '50 RIBU', 'Ternyata...', '5 JUTA?!',
  ]);
  assert.deepEqual(split('gue cuma punya seratus ribu tapi laptopnya harganya dua puluh juta'), [
    'Gue cuma punya', '100 RIBU', 'Tapi laptopnya harganya', '20 JUTA',
  ]);
});

test('splitting respects limits and avoids ending on function words', () => {
  const caps = split('so today we are going to talk about how to grow your channel faster than ever before', 'viral', 'en');
  for (const c of caps) {
    assert.ok(c.split(' ').length <= 5, c);
    assert.ok(!/ (to|the|your|about)$/i.test(c), `ends on function word: ${c}`);
  }
  assert.equal(caps.join(' ').toLowerCase(), 'so today we are going to talk about how to grow your channel faster than ever before');
});

test('never merges across a long pause and timing stays monotonic', () => {
  const caps = processSubtitles(
    [{ start: 0, end: 1, text: 'hello there' }, { start: 3, end: 4, text: 'general kenobi' }],
    DEFAULT_PRESET, DEFAULT_OPTIONS, { width: 1920, height: 1080 },
  ).captions;
  assert.deepEqual(caps.map((c) => c.words.map((w) => w.text).join(' ')), ['Hello there', 'General kenobi']);
  caps.forEach((c, i) => {
    assert.ok(c.end > c.start);
    if (caps[i + 1]) assert.ok(c.end <= caps[i + 1].start + 1e-9);
  });
});

test('keyword scoring ranks numbers and emotion over function words', () => {
  const id = LANGUAGES.id;
  const toks = scoreKeywords(normalizeNumbers(tokenize(cue('harganya mahal banget cuma lima juta')), id, 'auto'), id);
  const score = (t: string) => toks.find((x) => x.text === t)!.score;
  assert.ok(score('5 JUTA') >= 90);
  assert.ok(score('mahal') >= 60);
  assert.equal(score('cuma'), 0);
  const en = scoreKeywords(tokenize(cue('this is INSANE!')), LANGUAGES.en);
  assert.ok(en[2].score > 90);
});

test('filler removal is opt-in and conservative', () => {
  const run = (text: string, lang: LangCode) =>
    removeFillers(tokenize(cue(text)), LANGUAGES[lang]).map((t) => t.text + t.punct).join(' ');
  assert.equal(run('eh gue tuh, kayak, males banget', 'id'), 'gue tuh, males banget');
  assert.equal(run('mukanya kayak artis', 'id'), 'mukanya kayak artis'); // "kayak" = "like/similar": kept
  assert.equal(run('um I was, you know, tired.', 'en'), 'I was, tired.');
  assert.equal(run('I like pizza', 'en'), 'I like pizza');
  assert.deepEqual(split('eh gue tuh males banget', 'viral', 'id'), ['Eh gue tuh males banget']); // off by default
});

test('language detection', () => {
  assert.equal(detectLanguage(['gue nggak tau kenapa harganya mahal banget']).code, 'id');
  assert.equal(detectLanguage(['I do not know why this is so expensive']).code, 'en');
});

test('layout: balanced line breaks and safe placement', () => {
  assert.deepEqual(breakLines([100, 100], 10, 500, 2), [0, 0]);
  assert.deepEqual(breakLines([200, 200, 200, 200], 10, 500, 2), [0, 0, 1, 1]);
  assert.deepEqual(breakLines([400, 50, 50, 50], 10, 300, 2), [0, 1, 1, 1]);
  const l = computeLayout({ width: 1080, height: 1920 }, DEFAULT_PRESET, true);
  assert.ok(l.centerY + DEFAULT_PRESET.fontSize <= 1920 * 0.8, 'clear of the bottom social UI');
  assert.ok(l.maxWidth <= 1080 * 0.8);
  assert.equal(computeLayout({ width: 3840, height: 2160 }, DEFAULT_PRESET, false).fontSize, 144);
});

test('presets: built-ins load and validation rejects bad input', () => {
  const pm = new PresetManager();
  assert.equal(pm.list().length, 9);
  assert.equal(pm.get('viral').fontSize, 84);
  assert.equal(pm.get('viral').maxLines, 2); // inherited default
  assert.throws(() => validatePreset({ id: 'x', name: 'X', animation: 'explode' }), /animation/);
  assert.throws(() => validatePreset({ id: 'x', name: 'X', textColor: 'white' }), /textColor/);
  assert.throws(() => pm.save({ id: 'viral', name: 'Mine' }), /built-in/);
  pm.save({ id: 'mine', name: 'Mine', keywordColor: '#00FF00' });
  assert.equal(JSON.parse(pm.export('mine')).keywordColor, '#00FF00');
});

test('animation envelopes start hidden, pop overshoots, and all settle to rest', () => {
  const smEnv = new Function(`${ENV_FN}; return smEnv;`)() as (t: number, type: number, k: number) => number[];
  assert.deepEqual(smEnv(-0.1, 1, 1), [1, 0, 0, 0, 0]);
  const pop = [0, 0.12, 0.5].map((t) => smEnv(t, 1, 1)[0]);
  assert.ok(Math.abs(pop[0] - 0.8) < 1e-9 && Math.abs(pop[1] - 1.1) < 1e-9 && Math.abs(pop[2] - 1) < 1e-9);
  assert.equal(smEnv(0.06, 1, 0)[0], 1, 'intensity 0 removes motion');
  ANIMATIONS.forEach((_, i) => {
    const [s, o, dx, dy, b] = smEnv(2, i + 1, 1);
    assert.ok(Math.abs(s - 1) < 1e-6 && o === 1 && Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6 && b < 1e-6, ANIMATIONS[i]);
  });
});

test('host caption maps keywords and times to whitespace words (Premiere selectors)', () => {
  const r = processSubtitles(cue('gue cuma punya seratus ribu'), new PresetManager().get('viral'), DEFAULT_OPTIONS, { width: 1080, height: 1920 });
  const h = toHostCaption(r.captions[1]);
  assert.equal(h.text, '100 RIBU');
  assert.equal(h.kw, '1,2'); // "100" and "RIBU" are both emphasized words
  assert.equal(h.times.split(',').length, 2);
});

test('premiere template fit maps sequence layout into template units', async () => {
  const { premiereFit } = await import('../src/core/pipeline.ts');
  const frame = { width: 2160, height: 3840 };
  const layout = computeLayout(frame, DEFAULT_PRESET, true);
  const fit = premiereFit(frame, layout);
  assert.equal(fit.templateFile, 'SubMotion_Caption_1080x1920.mogrt');
  assert.equal(fit.motionScale, 200);
  assert.equal(fit.sizePct, 36); // 144px wanted / (200px template font * 2)
  assert.ok(Math.abs(fit.positionYPct - (layout.centerY / 3840) * 100) < 0.01);
  assert.equal(premiereFit({ width: 1920, height: 1080 }, computeLayout({ width: 1920, height: 1080 }, DEFAULT_PRESET, true)).motionScale, 100);
});

test('every generated AE / mogrt expression is valid JavaScript', async () => {
  const { aeWordExpressions, mogrtExpressions } = await import('../src/core/animation-engine/index.ts');
  for (const [name, expr] of Object.entries({ ...aeWordExpressions('SubMotion Captions'), ...mogrtExpressions() }))
    assert.doesNotThrow(() => new Function(expr), name);
});

test('Stack preset: always one emphasis, phrase spreading, emphasis gets its own line', () => {
  const style = new PresetManager().get('stack');
  const caps = processSubtitles(cue('the job of knives has traditionally been that your country maintains the ability'), style, { ...DEFAULT_OPTIONS, language: 'en' }, { width: 1920, height: 1080 }).captions;
  for (const c of caps) {
    assert.ok(c.words.some((w) => w.emphasis), `no emphasis in "${c.words.map((w) => w.text).join(' ')}"`);
    const lines = new Set(c.words.map((w) => w.line));
    for (const l of lines) {
      const cls = new Set(c.words.filter((w) => w.line === l).map((w) => w.emphasis));
      assert.equal(cls.size, 1, 'a line mixes normal and emphasis words');
    }
    assert.ok(c.words.every((w) => w.text === w.text.toLowerCase()));
  }
});

test('words-per-line limit forces extra lines', () => {
  assert.deepEqual(breakLines([50, 50, 50, 50], 10, 1000, 2, 2), [0, 0, 1, 1]);
});

test('velocity changes the ease but not the end state', () => {
  const smEnv = new Function(`${ENV_FN}; return smEnv;`)() as (t: number, type: number, k: number, v?: number) => number[];
  assert.ok(smEnv(0.1, 3, 1, 100)[1] > smEnv(0.1, 3, 1, 0)[1]); // sharper ease = more opaque early
  assert.equal(smEnv(1, 3, 1, 100)[1], 1);
  assert.equal(smEnv(0, 10, 1)[1], 0); // snap starts hidden
  assert.equal(smEnv(0.05, 10, 1)[1], 1); // and is fully visible within ~2 frames
});

test('stacked lines respect words-per-line', async () => {
  const { stackLines } = await import('../src/core/layout-engine/index.ts');
  const w = (emphasis: boolean) => ({ text: 'x', start: 0, end: 1, score: 0, emphasis, line: 0 });
  const cap = { index: 0, start: 0, end: 1, words: [w(true), w(false), w(false), w(false), w(false), w(false)] };
  assert.deepEqual(stackLines(cap, 3, 3), [0, 1, 1, 1, 2, 2]); // 1 emphasis line, then 5 normal words as 3 + 2
  assert.equal(stackLines(cap, 2, 3), null);
});

test('digit-form money from transcripts is recognized and emphasized', () => {
  assert.equal(numbers('I paid $5,000 today', 'en'), 'I paid $5,000 today');
  assert.equal(numbers('$2,500,000', 'en'), '$2.5 MILLION');
  assert.equal(numbers('harganya Rp50.000 aja', 'id'), 'harganya Rp50 RIBU aja');
  const en = LANGUAGES.en;
  const toks = scoreKeywords(normalizeNumbers(tokenize(cue('I paid $5,000 for this')), en, 'auto'), en);
  assert.ok(toks.find((t) => t.text === '$5,000')!.score >= 90);
});

test('mogrtComplete only accepts a finished zip with the AE project inside', async () => {
  const { mogrtComplete } = await import('../src/core/pipeline.ts');
  const eocd = (entries: number) => {
    const b = new Uint8Array(22);
    b.set([0x50, 0x4b, 0x05, 0x06]);
    b[10] = entries;
    return b;
  };
  const withBody = (tail: Uint8Array) => new Uint8Array([...new Uint8Array(100).fill(7), ...tail]);
  assert.equal(mogrtComplete(withBody(eocd(3))), true);
  assert.equal(mogrtComplete(withBody(eocd(1))), false, 'only definition.json written so far');
  assert.equal(mogrtComplete(new Uint8Array(500).fill(7)), false, 'still writing, no end record');
});

test('template sliders stay inside the 0..100 range Premiere allows', async () => {
  const { speedToSlider, buildHostJob } = await import('../src/core/pipeline.ts');
  assert.equal(speedToSlider(100), 50);
  assert.equal(speedToSlider(200), 75);
  assert.equal(speedToSlider(50), 25);
  assert.equal(speedToSlider(1000), 100);
  const style = new PresetManager().get('punch'); // emphasisSizeMul 1.45
  const job = buildHostJob(style, DEFAULT_OPTIONS, computeLayout({ width: 1080, height: 1920 }, style, true), { width: 1080, height: 1920 }, false);
  assert.equal(job.controls.emphasisSizeExtra, 45);
  for (const v of [job.controls.speed, job.controls.intensity, job.controls.emphasisIntensity, job.controls.velocity, job.controls.emphasisSizeExtra])
    assert.ok(v >= 0 && v <= 100);
});
