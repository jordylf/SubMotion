import type { Word } from '../core/types.ts';
import { parseWhisperJson, type MediaPlacement } from '../core/transcript/index.ts';

/**
 * Local speech-to-text with whisper.cpp + ffmpeg, run from the panel through CEP's Node.js
 * (manifest: --enable-nodejs --mixed-context). Nothing leaves the machine.
 */
export interface WhisperConfig {
  whisperPath: string; // whisper-cli(.exe)
  modelPath: string; // ggml-*.bin
  ffmpegPath: string; // "ffmpeg" if on PATH
  vadModelPath?: string; // optional ggml-silero-*.bin: skips silence so word times stay accurate after pauses
}

type NodeRequire = (id: string) => any;
export const nodeRequire: NodeRequire | undefined =
  (window as unknown as { cep_node?: { require: NodeRequire } }).cep_node?.require ??
  (window as unknown as { require?: NodeRequire }).require;

export const transcriptionAvailable = () => !!nodeRequire;

/** Where downloaded models live: %APPDATA%\SubMotion\models (per user, survives extension updates). */
export function modelsDir(): string {
  return nodeRequire!('path').join(userDataDir(), 'models');
}

/** Per-user SubMotion data (%APPDATA%\SubMotion). The installed extension folder is signed and must stay untouched. */
export function userDataDir(): string {
  const path = nodeRequire!('path');
  const env = nodeRequire!('process').env;
  return path.join(env.APPDATA ?? path.join(env.HOME ?? '', 'Library', 'Application Support'), 'SubMotion');
}

/**
 * Finds the tools without any path typing, in order: bundled with the extension (bin/win), the
 * per-user models folder, then the older manual-install spots (C:\tools\whisper, winget's ffmpeg).
 * Avoids PATH, which apps launched before an install don't see.
 */
export function detectWhisperDefaults(extensionDir?: string): Partial<WhisperConfig> {
  if (!nodeRequire) return {};
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const list = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
  const bundled = extensionDir ? path.join(extensionDir, 'bin', 'win') : '';
  const legacy = 'C:\\tools\\whisper';
  const out: Partial<WhisperConfig> = {};

  out.whisperPath = [bundled && path.join(bundled, 'whisper-cli.exe'), path.join(legacy, 'Release', 'whisper-cli.exe'), path.join(legacy, 'whisper-cli.exe')]
    .find((p) => p && exists(p));

  for (const dir of [modelsDir(), legacy]) {
    const files = list(dir);
    const models = files.filter((f) => /^ggml-.*\.bin$/.test(f) && !f.includes('silero'));
    // Prefer the recommended model when several are present.
    const model = models.find((f) => f.includes('large-v3-turbo')) ?? models[0];
    if (model && !out.modelPath) out.modelPath = path.join(dir, model);
    const vad = files.filter((f) => /^ggml-silero-.*\.bin$/.test(f)).sort().pop();
    if (vad && !out.vadModelPath) out.vadModelPath = path.join(dir, vad);
  }

  const downloaded = path.join(userDataDir(), 'bin', 'ffmpeg.exe'); // first-use download (models.ts)
  if (bundled && exists(path.join(bundled, 'ffmpeg.exe'))) out.ffmpegPath = path.join(bundled, 'ffmpeg.exe');
  else if (exists(downloaded)) out.ffmpegPath = downloaded;
  else {
    const local = nodeRequire('process').env.LOCALAPPDATA ?? '';
    const links = path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (exists(links)) out.ffmpegPath = links;
    else {
      const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
      for (const pkg of list(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg')))
        for (const sub of list(path.join(pkgs, pkg))) {
          const exe = path.join(pkgs, pkg, sub, 'bin', 'ffmpeg.exe');
          if (exists(exe)) out.ffmpegPath = exe;
        }
    }
  }
  return out;
}

export interface TranscribeJob {
  promise: Promise<{ language: string; words: Word[] }>;
  cancel(): void;
}

/**
 * Transcribes only the visible (trimmed) part of the media. Returned word times are in MEDIA time;
 * map them to the timeline with placeWords().
 */
export function transcribe(
  media: MediaPlacement,
  language: 'auto' | 'id' | 'en',
  cfg: WhisperConfig,
  onProgress: (pct: number, phase: string) => void,
): TranscribeJob {
  if (!nodeRequire) throw new Error('Node.js is not enabled in this panel (CEP --enable-nodejs).');
  const cp = nodeRequire('child_process');
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const path = nodeRequire('path');

  for (const [label, p] of [['whisper-cli', cfg.whisperPath], ['Whisper model', cfg.modelPath]] as const)
    if (!p || !fs.existsSync(p)) throw new Error(`${label} not found: "${p || '(not set)'}". Set it in Transcription setup.`);

  let current: { kill(): void } | null = null;
  let cancelled = false;

  const run = (cmd: string, args: string[], onLine: (l: string) => void) =>
    new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(cmd, args, { windowsHide: true });
      current = proc;
      let tail = '';
      const onData = (d: unknown) => {
        const s = String(d);
        tail = (tail + s).slice(-3000);
        s.split(/[\r\n]+/).forEach(onLine);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e: Error) => reject(new Error(`Cannot run ${cmd}: ${e.message}`)));
      proc.on('close', (code: number | null) => {
        current = null;
        if (cancelled) reject(new Error('Transcription cancelled.'));
        else if (code === 0) resolve();
        else if (code === 3221225781 || code === -1073741515)
          // STATUS_DLL_NOT_FOUND: whisper.cpp needs the Microsoft Visual C++ runtime.
          reject(new Error('A Windows component is missing. Install the "Microsoft Visual C++ Redistributable 2015-2022 (x64)" from microsoft.com, then try again.'));
        else reject(new Error(`${path.basename(cmd)} failed (exit ${code}):\n${tail.trim().split('\n').slice(-4).join('\n')}`));
      });
    });

  const promise = (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'submotion-'));
    try {
      // Trimmed range in media time; ffmpeg seeks so a 10 s clip from a 1 h file stays fast.
      const mFrom = Math.max(0, (media.from - media.offset) / media.rate);
      const mLen = Math.max(0.1, (media.to - media.from) / media.rate);
      const wav = path.join(dir, 'audio.wav');
      onProgress(0, 'Extracting audio');
      await run(cfg.ffmpegPath || 'ffmpeg',
        ['-y', '-ss', String(mFrom), '-t', String(mLen), '-i', media.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
        (l) => {
          const m = /time=(\d+):(\d+):([\d.]+)/.exec(l);
          if (m) onProgress(Math.min(10, ((+m[1] * 3600 + +m[2] * 60 + +m[3]) / mLen) * 10), 'Extracting audio');
        });

      onProgress(10, 'Transcribing');
      const out = path.join(dir, 'out');
      const threads = String(Math.max(1, Math.min(8, (os.cpus()?.length ?? 4) - 1)));
      await run(cfg.whisperPath,
        // -ml 1 -sow = one segment per word, which gives word-level timestamps.
        ['-m', cfg.modelPath, '-f', wav, '-l', language, '-ml', '1', '-sow', '-oj', '-of', out, '-pp', '-t', threads,
          ...(cfg.vadModelPath && fs.existsSync(cfg.vadModelPath) ? ['--vad', '-vm', cfg.vadModelPath] : [])],
        (l) => {
          const m = /progress\s*=\s*(\d+)%/.exec(l);
          if (m) onProgress(10 + +m[1] * 0.9, 'Transcribing');
        });

      const res = parseWhisperJson(fs.readFileSync(out + '.json', 'utf8'));
      // Back to absolute media time.
      res.words = res.words.map((w) => ({ text: w.text, start: w.start + mFrom, end: w.end + mFrom }));
      onProgress(100, 'Done');
      return res;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
    }
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      (current as { kill(): void } | null)?.kill();
    },
  };
}
