import type { LanguagePack, NumberMatch } from '../../core/language-engine/index.ts';
import { formatDecimal, groupThousands, parseDigits } from '../../core/language-engine/number-utils.ts';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const DIGIT_SUFFIX = /^(\d+(?:[.,]\d+)?)(k|m|b|%)$/;
const SUFFIX_SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

function parseNumber(norms: string[], i: number): NumberMatch | null {
  let j = i, total = 0, group = 0, frac = '', any = false, digits = false, scale = 0;
  // Transcripts write money as digits: "$5,000".
  const cur = (norms[i] ?? '').startsWith('$');
  const first = cur ? norms[i].slice(1) : norms[i] ?? '';
  const suffixed = DIGIT_SUFFIX.exec(first);
  const d = parseDigits(suffixed ? suffixed[1] : first, '.');
  if (d !== null) {
    digits = any = true;
    j++;
    if (suffixed?.[2] === '%') return { len: 1, value: d, scale: 0, unit: '%', digits };
    const s = suffixed ? SUFFIX_SCALE[suffixed[2]] : SCALES[norms[j]];
    if (s) {
      if (!suffixed) j++;
      total = d * s;
      scale = s;
    } else group = d;
  } else if (first === 'a' && (norms[i + 1] === 'hundred' || norms[i + 1] in SCALES)) {
    group = 1;
    j++;
    any = true;
  }
  while (!digits && j < norms.length) {
    const t = norms[j];
    const prevTensOnly = group % 100 >= 20 && group % 10 === 0;
    if (t in SMALL && !frac) {
      const v = SMALL[t];
      if (any && group % 100 !== 0 && !(prevTensOnly && v < 10)) break; // "two three" is not a number
      group += v;
    } else if (t === 'hundred' && group) group *= 100;
    else if (t in SCALES && (group || frac)) {
      total += (group + (frac ? Number('0.' + frac) : 0)) * SCALES[t];
      scale = Math.max(scale, SCALES[t]);
      group = 0;
      frac = '';
    } else if (t === 'and' && any && norms[j + 1] in SMALL && group >= 100) { /* "one hundred and five" */ }
    else if (t === 'point' && any && SMALL[norms[j + 1]] < 10) {
      while (SMALL[norms[j + 1]] < 10) frac += SMALL[norms[++j]];
    } else break;
    any = true;
    j++;
  }
  if (!any) return null;
  const value = total + group + (frac ? Number('0.' + frac) : 0);
  let u: NumberMatch['unit'] = cur ? 'currency' : '';
  if (norms[j] === 'percent') { u = '%'; j++; }
  else if (norms[j] === 'per' && norms[j + 1] === 'cent') { u = '%'; j += 2; }
  else if (norms[j] === 'dollars' || norms[j] === 'dollar' || norms[j] === 'bucks') { u = 'currency'; j++; }
  return { len: j - i, value, scale, unit: u, digits };
}

const NAMES: [number, string][] = [[1e12, 'TRILLION'], [1e9, 'BILLION'], [1e6, 'MILLION'], [1e3, 'K']];

function formatNumber(m: NumberMatch, style: 'auto' | 'compact' | 'full'): string {
  if (m.unit === '%') return formatDecimal(m.value, '.') + '%';
  const threshold = style === 'compact' ? 1e3 : 1e6;
  let body = groupThousands(m.value, '.');
  if (style !== 'full' && m.value >= threshold) {
    const [s, name] = NAMES.find(([s]) => m.value >= s)!;
    body = formatDecimal(m.value / s, '.') + (name === 'K' ? 'K' : ' ' + name);
  }
  return m.unit === 'currency' ? '$' + body : body;
}

export const english: LanguagePack = {
  code: 'en',
  name: 'English',
  common: set(`the a an and or but is are was were be been to of in on at for with from by as it this that
    these those i you he she we they me my your his her our their not no yes do does did have has had will
    would can could should just so if then there here what when where why how who which about like get got
    really very all some any more most than too also`),
  hardFillers: set('uh uhh um umm uhm erm er hmm mm'),
  softFillers: [['you', 'know'], ['i', 'mean'], ['like'], ['basically'], ['literally'], ['actually']],
  noEnd: set(`the a an of to in on at for with from by as about into onto than and or but my your his her their our its this that
    very really not so i we they he she is are was were be`),
  noStart: set('too though'),
  contrast: set('but however actually instead although though yet except'),
  reveal: set('actually suddenly instead'),
  emotional: set(`amazing crazy insane huge terrible awesome incredible love hate best worst never always free
    secret wow shocked scared angry happy sad money rich broke win lose fail failed success important
    dangerous viral first last unbelievable perfect disaster`),
  strongVerbs: set('buy sell pay win lose build break destroy grow start stop change quit launch crush double triple steal'),
  decimalSep: '.',
  parseNumber,
  formatNumber,
};
