import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake https: first request redirects (like Hugging Face), the second streams the body.
const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-appdata-'));
let mode: 'ok' | 'short' | 'corrupt' | 'drop' = 'ok';
const fakeHttps = {
  get(url: string, _opts: unknown, cb: (res: unknown) => void) {
    const req = Object.assign(new EventEmitter(), { destroy() {} });
    setTimeout(() => {
      if (url.includes('huggingface.co')) {
        const res = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'https://cdn.example/x' } });
        cb(res);
        res.end();
        return;
      }
      const body = Buffer.from(mode === 'corrupt' ? 'tampered!!!' : 'model-bytes');
      const res = Object.assign(new PassThrough(), { statusCode: 200, complete: false, headers: { 'content-length': String(mode === 'short' ? 99 : body.length) } });
      res.on('end', () => (res.complete = true)); // like Node's IncomingMessage
      cb(res);
      if (mode === 'drop') {
        res.write(body.subarray(0, 4));
        setTimeout(() => res.destroy()); // connection lost: 'close' without 'end'
        return;
      }
      res.end(body);
    });
    return req;
  },
};
const req = createRequire(import.meta.url);
const realProcess = req('process');
(globalThis as Record<string, unknown>).window = {
  cep_node: {
    require: (id: string) =>
      id === 'https' ? fakeHttps : id === 'process' ? { ...realProcess, env: { ...realProcess.env, APPDATA: appdata } } : req(id),
  },
};
const { downloadTools, modelsMissing, MODELS } = await import('../src/ui/models.ts');
const { createHash } = await import('node:crypto');
// Real checksums would not match the fake body; pin them to it.
for (const m of MODELS) m.sha256 = createHash('sha256').update('model-bytes').digest('hex');
const models = (cb: (pct: number) => void = () => {}) => downloadTools({ models: true, ffmpeg: false }, cb);

test('an incomplete download leaves no model file behind', async () => {
  mode = 'short';
  await assert.rejects(models().promise, /incomplete/);
  assert.ok(!fs.existsSync(path.join(appdata, 'SubMotion', 'models', MODELS[0].file)));
  assert.equal(modelsMissing(), true);
});

test('a dropped connection rejects instead of hanging', async () => {
  mode = 'drop';
  await assert.rejects(models().promise, /Connection lost/);
  assert.ok(!fs.existsSync(path.join(appdata, 'SubMotion', 'models', MODELS[0].file)));
});

test('a download whose checksum does not match is rejected and removed', async () => {
  mode = 'corrupt';
  await assert.rejects(models().promise, /checksum/);
  const dir = path.join(appdata, 'SubMotion', 'models');
  assert.ok(!fs.existsSync(path.join(dir, MODELS[0].file)) && !fs.existsSync(path.join(dir, MODELS[0].file + '.part')));
});

test('VAD-only download never fetches the speech model for a custom model user', async () => {
  mode = 'ok';
  await downloadTools({ models: false, vad: true, ffmpeg: false }, () => {}).promise;
  const dir = path.join(appdata, 'SubMotion', 'models');
  assert.equal(fs.existsSync(path.join(dir, MODELS[0].file)), false);
  assert.equal(fs.readFileSync(path.join(dir, MODELS[1].file), 'utf8'), 'model-bytes');
});

test('downloads every model through redirects into %APPDATA%/SubMotion/models', async () => {
  mode = 'ok';
  const seen: number[] = [];
  await models((pct) => seen.push(pct)).promise;
  for (const m of MODELS) assert.equal(fs.readFileSync(path.join(appdata, 'SubMotion', 'models', m.file), 'utf8'), 'model-bytes');
  assert.equal(modelsMissing(), false);
  assert.equal(seen[seen.length - 1], 100);
});
