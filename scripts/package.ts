// Builds the signed release package: release/SubMotion-<version>.zxp
// Usage: npm run package   (runs build + fetch:bins first via package.json)
//
// Signing uses Adobe's ZXPSignCmd with a self-signed certificate created on first run in signing/
// (git-ignored). Keep signing/ backed up: future releases should be signed with the same certificate.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p: string[]) => path.join(root, ...p);
const version: string = JSON.parse(readFileSync(at('package.json'), 'utf8')).version;

// 1. Signing tool (official Adobe CEP resources) and certificate.
const tool = at('bin', '.cache', 'ZXPSignCmd.exe');
const TOOL_SHA256 = 'dc2e711a46504830062ac1afede1f8ee08c1e21399b6c30d7d38cf907c35bcf5';
if (!existsSync(tool)) {
  mkdirSync(path.dirname(tool), { recursive: true });
  const url = 'https://github.com/Adobe-CEP/CEP-Resources/raw/de5053ce92705e4a4ec68f519fc962dfbae70724/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe';
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`ZXPSignCmd download failed: ${res.status}`);
  writeFileSync(tool, Buffer.from(await res.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(tool)).digest('hex') !== TOOL_SHA256) {
  rmSync(tool);
  throw new Error('ZXPSignCmd checksum mismatch');
}
const cert = at('signing', 'submotion.p12');
const passFile = at('signing', 'password.txt');
if (!existsSync(cert)) {
  mkdirSync(at('signing'), { recursive: true });
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passFile, password);
  execFileSync(tool, ['-selfSignedCert', 'ID', 'NA', 'SubMotion', 'SubMotion', password, cert, '-validityDays', '3650'], { stdio: 'inherit' });
  console.log('created signing/submotion.p12 (back up the signing/ folder)');
}
const password = readFileSync(passFile, 'utf8').trim();

// 2. Stage only what users need. Not shipped: .debug (opens debug ports), tests, dev scripts, TS sources.
const stage = at('release', 'stage');
rmSync(stage, { recursive: true, force: true });
const files = [
  'CSXS/manifest.xml',
  'dist/panel.js',
  'src/ui/index.html',
  'src/ui/style.css',
  'src/host/main.jsx',
  'src/after-effects/host.jsx',
  'src/premiere/host.jsx',
  'assets/mogrt/SubMotion_Caption_1080x1920.mogrt',
  'assets/mogrt/SubMotion_Caption_1920x1080.mogrt',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
for (const f of files) {
  if (!existsSync(at(f))) throw new Error(`missing ${f} (run npm run build / build:template first)`);
  mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
  copyFileSync(at(f), path.join(stage, f));
}
if (!existsSync(at('bin', 'win', 'whisper-cli.exe'))) throw new Error('missing bin/win (run npm run fetch:bins)');
if (!existsSync(at('bin', 'win', 'whisper.cpp-LICENSE.txt'))) throw new Error('missing whisper.cpp license (run npm run fetch:bins)');
cpSync(at('bin', 'win'), path.join(stage, 'bin', 'win'), { recursive: true });

// Manifest version follows package.json (bundle version + the extension's own version).
const manifest = path.join(stage, 'CSXS', 'manifest.xml');
let replaced = 0;
const xml = readFileSync(manifest, 'utf8').replace(
  /(ExtensionBundleVersion="|<Extension Id="com\.submotion\.panel" Version=")[^"]*"/g,
  (_m, head) => (replaced++, `${head}${version}"`),
);
if (replaced !== 2) throw new Error(`expected 2 version attributes in the manifest, found ${replaced}`);
writeFileSync(manifest, xml);

// 3. Sign and verify. No -tsa: ZXPSignCmd 4.1.103 crashes (0xC0000005) with every timestamp server
// tried, so the signature is valid for the certificate's lifetime (10 years). Signing runs from a temp
// dir: Adobe's command-line tools are unreliable with spaces in paths.
const tmp = mkdtempSync(path.join(tmpdir(), 'smzxp-'));
const zxp = at('release', `SubMotion-${version}.zxp`);
try {
  cpSync(stage, path.join(tmp, 'stage'), { recursive: true });
  copyFileSync(cert, path.join(tmp, 'cert.p12'));
  execFileSync(tool, ['-sign', path.join(tmp, 'stage'), path.join(tmp, 'out.zxp'), path.join(tmp, 'cert.p12'), password], { stdio: 'inherit' });
  execFileSync(tool, ['-verify', path.join(tmp, 'out.zxp'), '-certInfo'], { stdio: 'inherit' });
  copyFileSync(path.join(tmp, 'out.zxp'), zxp);
} finally {
  rmSync(tmp, { recursive: true, force: true }); // never leave the private key behind in %TEMP%
}
console.log(`release/SubMotion-${version}.zxp (${Math.round(statSync(zxp).size / 1048576)} MB)`);
