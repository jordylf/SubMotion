// Downloads the whisper.cpp CLI bundled into the release package (Windows x64) into bin/win/.
// Pinned version + SHA-256; see THIRD_PARTY_NOTICES.md. FFmpeg is NOT bundled: the panel downloads it
// from its publisher on first use. Usage: node scripts/fetch-bins.ts
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WHISPER = {
  tag: 'b5454',
  zip: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  license: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/LICENSE',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'bin', 'win');
const cache = path.join(root, 'bin', '.cache');
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function download(url: string, file: string) {
  if (existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

mkdirSync(cache, { recursive: true });
const zip = path.join(cache, `whisper-${WHISPER.tag}.zip`);
await download(WHISPER.zip, zip);
if (sha256(zip) !== WHISPER.sha256) {
  rmSync(zip);
  throw new Error(`checksum mismatch for ${WHISPER.zip}`);
}

// Fresh output folder, so nothing dropped upstream (or left from older builds) ships.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Windows' own bsdtar: a GNU tar on PATH (e.g. Git's) reads "E:" as a remote host.
const tmp = mkdtempSync(path.join(tmpdir(), 'submotion-bin-'));
try {
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
  const dir = path.join(tmp, 'Release');
  // The CLI and the ggml/whisper DLLs it loads (CPU variants are picked at runtime).
  for (const f of readdirSync(dir).filter((f) => f === 'whisper-cli.exe' || f === 'whisper.dll' || /^ggml.*\.dll$/.test(f)))
    copyFileSync(path.join(dir, f), path.join(out, f));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const lic = await fetch(WHISPER.license);
if (!lic.ok) throw new Error(`could not fetch the whisper.cpp license (${lic.status})`);
writeFileSync(path.join(out, 'whisper.cpp-LICENSE.txt'), await lic.text());

console.log(`bin/win: ${readdirSync(out).join(', ')}`);
