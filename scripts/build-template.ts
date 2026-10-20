// Builds the Premiere .mogrt templates with the same host code as the panel's "Build Premiere template"
// button, in the open After Effects (its project must have been saved once; it gets saved again,
// because After Effects only exports from a project without unsaved changes).
// Usage: node scripts/build-template.ts [presetId]
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PresetManager } from '../src/core/preset-engine/index.ts';
import { DEFAULT_OPTIONS, TEMPLATES, TEMPLATE_FONT, buildHostJob, mogrtComplete } from '../src/core/pipeline.ts';
import { computeLayout } from '../src/core/layout-engine/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p: string) => p.split(path.sep).join('/');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = new PresetManager().get(process.argv[2] ?? 'stack');
const base = buildHostJob(st, DEFAULT_OPTIONS, computeLayout(TEMPLATES[0], st, true), TEMPLATES[0], false);
const job = { ...base, style: { ...base.style, fontSize: TEMPLATE_FONT, strokeWidth: (st.strokeWidth * TEMPLATE_FONT) / st.fontSize } };

const ae = ['2026', '2025', '2024', '2023'].map((v) => `C:\\Program Files\\Adobe\\Adobe After Effects ${v}\\Support Files\\AfterFX.exe`).find(existsSync);
if (!ae) throw new Error('After Effects not found');
const tmp = tmpdir();
const report = path.join(tmp, 'submotion-template-report.txt');

/** Runs a JSX body in the open After Effects (via a launcher in the temp dir: -r fails on paths with spaces). */
async function inAE(body: string): Promise<string> {
  rmSync(report, { force: true });
  writeFileSync(path.join(tmp, 'submotion-template.jsx'), `(function () {
  var out;
  try { ${body} } catch (e) { out = '{"ok":false,"error":"' + String(e).replace(/"/g, "'") + '"}'; }
  var f = new File("${fwd(report)}"); f.encoding = "UTF-8"; f.open("w"); f.write(out); f.close();
})();`);
  execFileSync(ae!, ['-r', path.join(tmp, 'submotion-template.jsx')]);
  for (let i = 0; i < 240 && !existsSync(report); i++) await sleep(500);
  if (!existsSync(report)) throw new Error('No answer: is After Effects open and idle (no dialog)?');
  return readFileSync(report, 'utf8');
}

const dest = path.join(root, 'assets', 'mogrt');
mkdirSync(dest, { recursive: true });
for (const t of TEMPLATES) {
  const l = computeLayout(t, st, true);
  const template = { ...t, fontSize: TEMPLATE_FONT, positionYPct: l.positionYPct, maxWidthPct: (l.maxWidth / t.width) * 100 };
  writeFileSync(path.join(tmp, 'submotion-template-arg.json'), JSON.stringify({ job, template }));
  const res = JSON.parse(await inAE(`
    $.evalFile(new File("${fwd(path.join(root, 'src', 'host', 'main.jsx'))}"));
    var a = new File("${fwd(path.join(tmp, 'submotion-template-arg.json'))}"); a.encoding = "UTF-8"; a.open("r");
    out = SM.call("buildTemplate", eval("(" + a.read() + ")")); a.close();`));
  if (!res.ok) throw new Error(res.error);
  // After Effects exports asynchronously: wait for a complete zip, never touching the file before.
  let done = false;
  for (let i = 0; i < 240 && !done; i++) {
    await sleep(500);
    done = existsSync(res.data.staged) && mogrtComplete(readFileSync(res.data.staged));
  }
  if (!done) throw new Error(`After Effects did not finish exporting ${t.file}`);
  await sleep(1000); // let AE close the file
  copyFileSync(res.data.staged, path.join(dest, t.file));
  console.log(`wrote assets/mogrt/${t.file} (${Math.round(statSync(res.data.staged).size / 1024)} KB)`);
}
// Remove the template comps again.
await inAE(`for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i);
  if (it instanceof FolderItem && it.name === "SubMotion Templates") { it.remove(); break; } } out = "cleaned";`);
