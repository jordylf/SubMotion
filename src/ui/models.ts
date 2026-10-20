import { modelsDir, nodeRequire, userDataDir } from './transcriber.ts';

/**
 * Things transcription needs that are downloaded once, on first use, straight from their publishers
 * (SubMotion does not redistribute them; see THIRD_PARTY_NOTICES.md). Models are pinned to a
 * Hugging Face revision and checked against their SHA-256 before use.
 */
export const MODELS = [
  {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    label: 'Whisper speech model',
  },
  {
    file: 'ggml-silero-v6.2.0.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    label: 'voice detection model',
  },
];

/** FFmpeg LGPL build by BtbN (official GitHub releases); only ffmpeg.exe and its license are kept. */
export const FFMPEG = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip',
  fallbackUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip',
  label: 'FFmpeg',
};

export const ffmpegDir = () => nodeRequire!('path').join(userDataDir(), 'bin');

export interface DownloadJob {
  promise: Promise<void>;
  cancel(): void;
}

/**
 * Downloads what is listed in `need`. Each file streams to "<file>.part" and is renamed only when
 * complete (and, for models, when its SHA-256 matches), so a failure never leaves a broken file.
 */
export function downloadTools(need: { models: boolean; vad?: boolean; ffmpeg: boolean }, onProgress: (pct: number, label: string) => void): DownloadJob {
  const fs = nodeRequire!('fs');
  const path = nodeRequire!('path');
  const https = nodeRequire!('https');
  const crypto = nodeRequire!('crypto');
  let current: { destroy(): void } | null = null;
  let cancelled = false;
  const cancelError = () => new Error('Download cancelled.');

  const fetchTo = (url: string, dest: string, label: string, sha256?: string, redirects = 5): Promise<void> =>
    new Promise((resolve, reject) => {
      if (cancelled) return reject(cancelError());
      let out: any = null;
      const fail = (e: Error) => {
        out?.destroy();
        reject(cancelled ? cancelError() : e);
      };
      const req = https.get(url, { headers: { 'User-Agent': 'SubMotion' } }, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(fetchTo(new URL(res.headers.location, url).toString(), dest, label, sha256, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`Download failed (${res.statusCode}) for ${label}.`));
        }
        const total = Number(res.headers['content-length']) || 0;
        const hash = crypto.createHash('sha256');
        let got = 0;
        out = fs.createWriteStream(dest + '.part');
        res.on('data', (chunk: Uint8Array) => {
          got += chunk.length;
          hash.update(chunk);
          if (total) onProgress((got / total) * 100, label);
        });
        res.on('error', fail);
        // A dropped connection or cancel may only show up as "close" without "end" (Node 15 in CEP).
        res.on('close', () => {
          if (!res.complete) fail(new Error(`Connection lost while downloading ${label}.`));
        });
        out.on('error', fail);
        out.on('finish', () => {
          if (cancelled) return fail(cancelError());
          if (total && got !== total) return fail(new Error(`Download of ${label} was incomplete.`));
          if (sha256 && hash.digest('hex') !== sha256) {
            fs.rmSync(dest + '.part', { force: true });
            return fail(new Error(`Downloaded ${label} is corrupted (checksum mismatch). Please try again.`));
          }
          fs.renameSync(dest + '.part', dest);
          resolve();
        });
        res.pipe(out);
      });
      current = req;
      req.on('error', fail);
    });

  const promise = (async () => {
    if (need.models || need.vad) {
      fs.mkdirSync(modelsDir(), { recursive: true });
      for (const m of MODELS) {
        if (!need.models && m !== MODELS[1]) continue;
        const dest = path.join(modelsDir(), m.file);
        if (!fs.existsSync(dest)) await fetchTo(m.url, dest, m.label, m.sha256);
      }
    }
    if (need.ffmpeg) {
      const dir = ffmpegDir();
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, 'ffmpeg.zip');
      try {
        await fetchTo(FFMPEG.url, zip, FFMPEG.label);
      } catch (e) {
        if (!String(e).includes('Download failed (404)')) throw e;
        await fetchTo(FFMPEG.fallbackUrl, zip, FFMPEG.label);
      }
      onProgress(100, 'Unpacking FFmpeg');
      await installFfmpeg(zip, dir);
      fs.rmSync(zip, { force: true });
    }
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      (current as { destroy(): void } | null)?.destroy();
    },
  };
}

/** Extracts ffmpeg.exe (+ license) from the BtbN zip with Windows' own tar (bsdtar reads zip). */
function installFfmpeg(zip: string, dir: string): Promise<void> {
  const fs = nodeRequire!('fs');
  const path = nodeRequire!('path');
  const os = nodeRequire!('os');
  const cp = nodeRequire!('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'submotion-ffmpeg-'));
  const tar = path.join(nodeRequire!('process').env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise<void>((resolve, reject) => {
    cp.execFile(tar, ['-xf', zip, '-C', tmp, '*/bin/ffmpeg.exe', '*/LICENSE.txt'], (err: Error | null) => {
      try {
        if (err) throw new Error(`Could not unpack FFmpeg: ${err.message}`);
        const find = (d: string, name: string): string => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isFile() && e.name.toLowerCase() === name) return p;
            if (e.isDirectory()) {
              const hit = find(p, name);
              if (hit) return hit;
            }
          }
          return '';
        };
        const exe = find(tmp, 'ffmpeg.exe');
        if (!exe) throw new Error('The FFmpeg download did not contain ffmpeg.exe.');
        fs.copyFileSync(exe, path.join(dir, 'ffmpeg.exe'));
        const lic = find(tmp, 'license.txt');
        if (lic) fs.copyFileSync(lic, path.join(dir, 'ffmpeg-LICENSE.txt'));
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}

export function modelsMissing(): boolean {
  const fs = nodeRequire!('fs');
  const path = nodeRequire!('path');
  return MODELS.some((m) => !fs.existsSync(path.join(modelsDir(), m.file)));
}
