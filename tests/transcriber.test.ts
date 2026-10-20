import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake child_process: "ffmpeg" just exits; "whisper" writes the -of JSON file and reports progress.
const calls: { cmd: string; args: string[] }[] = [];
let hang = false;
const fakeCp = {
  spawn(cmd: string, args: string[]) {
    calls.push({ cmd, args });
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => setTimeout(() => proc.emit('close', null)) });
    if (hang) return proc;
    setTimeout(() => {
      if (cmd.includes('whisper')) {
        proc.stderr.emit('data', 'whisper_print_progress_callback: progress =  50%\n');
        const out = args[args.indexOf('-of') + 1];
        fs.writeFileSync(out + '.json', JSON.stringify({ result: { language: 'id' }, transcription: [{ offsets: { from: 0, to: 400 }, text: ' halo' }, { offsets: { from: 500, to: 900 }, text: ' semua' }] }));
      } else proc.stderr.emit('data', 'size=1kB time=00:00:05.00 bitrate=1\n');
      proc.emit('close', 0);
    });
    return proc;
  },
};
const req = createRequire(import.meta.url);
(globalThis as Record<string, unknown>).window = { cep_node: { require: (id: string) => (id === 'child_process' ? fakeCp : req(id)) } };
const { transcribe } = await import('../src/ui/transcriber.ts');

const model = path.join(os.tmpdir(), 'sm-fake-model.bin');
const whisper = path.join(os.tmpdir(), 'sm-fake-whisper-cli.exe');
for (const f of [model, whisper]) fs.writeFileSync(f, ''); // existing files pass the path check
const cfg = { whisperPath: whisper, modelPath: model, ffmpegPath: 'ffmpeg' };

test('extracts only the trimmed range and returns words in media time', async () => {
  calls.length = 0;
  const progress: number[] = [];
  // Layer starts at 10 s in the comp and shows media 30..40 s (comp 40..50).
  const job = transcribe({ path: 'clip.mp4', offset: 10, rate: 1, from: 40, to: 50 }, 'id', cfg, (p) => progress.push(p));
  const res = await job.promise;
  const ff = calls[0].args;
  assert.equal(ff[ff.indexOf('-ss') + 1], '30');
  assert.equal(ff[ff.indexOf('-t') + 1], '10');
  const wh = calls[1].args;
  assert.deepEqual([wh[wh.indexOf('-l') + 1], wh.includes('-sow'), wh[wh.indexOf('-ml') + 1]], ['id', true, '1']);
  assert.deepEqual(res.words, [{ text: 'halo', start: 30, end: 30.4 }, { text: 'semua', start: 30.5, end: 30.9 }]);
  assert.ok(progress.includes(55) && progress[progress.length - 1] === 100);
  assert.ok(!fs.existsSync(path.dirname(wh[wh.indexOf('-of') + 1])), 'temp dir cleaned up');
});

test('missing whisper binary is reported before anything runs', () => {
  assert.throws(() => transcribe({ path: 'a', offset: 0, rate: 1, from: 0, to: 1 }, 'auto', { ...cfg, whisperPath: 'C:/nope/whisper-cli.exe' }, () => {}), /whisper-cli not found/);
});

test('cancel kills the running process', async () => {
  hang = true;
  const job = transcribe({ path: 'a', offset: 0, rate: 1, from: 0, to: 1 }, 'auto', cfg, () => {});
  await new Promise((r) => setTimeout(r, 20));
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  hang = false;
});
