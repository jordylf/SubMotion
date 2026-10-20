// Syntax + ES3 sanity check for ExtendScript files (they can't be run outside Adobe apps).
import { globSync, readFileSync } from 'node:fs';

const BANNED = [
  [/\b(let|const)\s/, 'let/const'],
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\.(forEach|map|filter|reduce|some|every)\(/, 'ES5 array method'],
  [/\bJSON\./, 'JSON object'],
];

let failed = false;
for (const file of globSync('src/**/*.jsx')) {
  const src = readFileSync(file, 'utf8');
  try {
    new Function(src);
  } catch (e) {
    console.error(`${file}: syntax error: ${e.message}`);
    failed = true;
  }
  const code = src
    .replace(/\/\/.*$/gm, '')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  for (const [re, what] of BANNED) {
    if (re.test(code)) {
      console.error(`${file}: ${what} is not available in ExtendScript (ES3)`);
      failed = true;
    }
  }
}
console.log(failed ? 'JSX check failed' : 'JSX check OK');
process.exit(failed ? 1 : 0);
