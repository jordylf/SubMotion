// Runs scripts/verify-ae.jsx inside the RUNNING After Effects and prints the report.
// Usage: node scripts/verify-ae.ts [presetId]   (AE must be open; the project is left unchanged)
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PresetManager } from '../src/core/preset-engine/index.ts';
import { DEFAULT_OPTIONS, buildHostJob } from '../src/core/pipeline.ts';
import { computeLayout } from '../src/core/layout-engine/index.ts';
import { aeWordExpressions } from '../src/core/animation-engine/index.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const frame = { width: 1080, height: 1920 };
const style = new PresetManager().get(process.argv[2] ?? 'stack');
const controlsComp = 'SM__verify';
const job = { ...buildHostJob(style, DEFAULT_OPTIONS, computeLayout(frame, style, true), frame, true), expr: aeWordExpressions(controlsComp), controlsComp };
writeFileSync(path.join(dir, '.verify-job.json'), JSON.stringify(job));
const report = path.join(dir, '.verify-report.txt');
rmSync(report, { force: true });

const ae = ['2026', '2025', '2024', '2023'].map((v) => `C:\\Program Files\\Adobe\\Adobe After Effects ${v}\\Support Files\\AfterFX.exe`).find(existsSync);
if (!ae) throw new Error('After Effects not found');
// AfterFX -r fails silently on paths with spaces, so hop through a launcher in the temp dir.
const launcher = path.join(tmpdir(), 'submotion-verify-launch.jsx');
writeFileSync(launcher, `$.evalFile(new File(${JSON.stringify(path.join(dir, 'verify-ae.jsx').split(path.sep).join('/'))}));`);
execFileSync(ae, ['-r', launcher]);
for (let i = 0; i < 60 && !existsSync(report); i++) await new Promise((r) => setTimeout(r, 500));
console.log(existsSync(report) ? readFileSync(report, 'utf8') : 'No report: is After Effects open and idle (no dialog)?');
