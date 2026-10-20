import type { LanguagePack, NumberMatch } from '../../core/language-engine/index.ts';
import { formatDecimal, groupThousands, parseDigits } from '../../core/language-engine/number-utils.ts';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const UNITS: Record<string, number> = {
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9,
};
const SE: Record<string, number> = { sepuluh: 10, sebelas: 11, seratus: 100 };
const SCALES: Record<string, number> = {
  ribu: 1e3, rb: 1e3, juta: 1e6, jt: 1e6, miliar: 1e9, milyar: 1e9, triliun: 1e12,
};
const SE_SCALES: Record<string, number> = { seribu: 1e3, sejuta: 1e6, semiliar: 1e9 };
const DIGIT_SUFFIX = /^(\d+(?:[.,]\d+)?)(rb|ribu|jt|juta|m|%)$/;

function parseNumber(norms: string[], i: number): NumberMatch | null {
  let j = i, total = 0, group = 0, unit = 0, frac = '', any = false, digits = false, scale = 0, inFrac = false;
  // Transcripts write money as digits: "Rp50.000" / "rp 50.000".
  const cur = /^rp\.?\d/.test(norms[i] ?? '');
  const first = cur ? norms[i].replace(/^rp\.?/, '') : norms[i] ?? '';
  const suffixed = DIGIT_SUFFIX.exec(first);
  const d = parseDigits(suffixed ? suffixed[1] : first, ',');
  if (d !== null) {
    digits = any = true;
    j++;
    if (suffixed?.[2] === '%') return { len: 1, value: d, scale: 0, unit: '%', digits };
    const s = suffixed ? (suffixed[2] === 'm' ? 1e9 : SCALES[suffixed[2]]) : SCALES[norms[j]];
    if (s) {
      if (!suffixed) j++;
      total = d * s;
      scale = s;
    } else group = d;
  }
  while (!digits && j < norms.length) {
    const t = norms[j];
    if (inFrac) {
      if (t in UNITS) { frac += UNITS[t]; j++; continue; }
      inFrac = false;
    }
    if (t in UNITS) {
      if (unit || (frac && !(t in SCALES))) break; // "dua tiga" is a range, not a number
      unit = UNITS[t];
    } else if (t in SE) group += SE[t];
    else if (t === 'belas' && unit) { group += unit + 10; unit = 0; }
    else if (t === 'puluh' && unit) { group += unit * 10; unit = 0; }
    else if (t === 'ratus' && unit) { group += unit * 100; unit = 0; }
    else if (t === 'koma' && any && norms[j + 1] in UNITS) { inFrac = true; }
    else if (t in SE_SCALES || (t in SCALES && (group || unit || frac))) {
      const s = SE_SCALES[t] ?? SCALES[t];
      const n = t in SE_SCALES ? 1 : group + unit + (frac ? Number('0.' + frac) : 0);
      total += n * s;
      scale = Math.max(scale, s);
      group = unit = 0;
      frac = '';
    } else break;
    any = true;
    j++;
  }
  if (!any) return null;
  const value = total + group + unit + (frac ? Number('0.' + frac) : 0);
  let u: NumberMatch['unit'] = cur ? 'currency' : '';
  if (norms[j] === 'persen') { u = '%'; j++; }
  else if (norms[j] === 'rupiah' || norms[j] === 'perak') { u = 'currency'; j++; }
  return { len: j - i, value, scale, unit: u, digits };
}

const NAMES: [number, string][] = [[1e12, 'TRILIUN'], [1e9, 'MILIAR'], [1e6, 'JUTA'], [1e3, 'RIBU']];

function formatNumber(m: NumberMatch, style: 'auto' | 'compact' | 'full'): string {
  if (m.unit === '%') return formatDecimal(m.value, ',') + '%';
  let body = groupThousands(m.value, ',');
  if (style !== 'full' && m.value >= 1000) {
    const [s, name] = NAMES.find(([s]) => m.value >= s)!;
    body = formatDecimal(m.value / s, ',') + ' ' + name;
  }
  return m.unit === 'currency' ? 'Rp' + body : body;
}

export const indonesian: LanguagePack = {
  code: 'id',
  name: 'Bahasa Indonesia',
  common: set(`yang dan di ke dari ini itu aku saya gue gw lo lu kamu kita kami mereka dia ada tidak nggak gak ga
    enggak udah sudah belum akan bisa mau juga aja saja sama dengan untuk buat karena kalau kalo tapi jadi terus
    lagi banget kok sih dong deh nih tuh kan ya iya apa gimana kenapa mana siapa kapan pas waktu sangat lebih
    paling cuma hanya punya harus atau pada oleh dalam sebagai bahwa seperti kayak gitu begitu jadi biar lalu
    harga harganya ribu juta rupiah persen satu dua tiga empat lima enam tujuh delapan sembilan puluh ratus`),
  hardFillers: set('eh ehh eee ee em emm ehm hmm hm mmm umm'),
  softFillers: [['apa', 'namanya'], ['anu'], ['kayak'], ['gitu'], ['kan'], ['tuh'], ['nih']],
  noEnd: set(`yang di ke dari untuk dan atau dengan karena kalau kalo jika pada oleh sama buat si sang para
    nggak gak ga enggak tidak bukan lebih paling sangat agak cuma hanya juga yg dgn dr utk tp`),
  noStart: set('kan sih dong deh lah nih tuh aja saja banget loh lho ya kah pun'),
  contrast: set('tapi tetapi namun padahal ternyata malah justru sedangkan sebaliknya'),
  reveal: set('ternyata padahal malah justru'),
  emotional: set(`gila parah mahal murah gratis keren mantap wow kaget sedih senang bahagia takut marah kesel kesal
    capek rugi untung sukses gagal menang kalah rahasia penting bahaya viral terbaik terburuk pertama terakhir
    hancur ajaib luar biasa sakit cinta benci kaya miskin bangkrut juara`),
  strongVerbs: set('beli jual bayar dapat dapet hilang bangun hancurkan berhasil mulai berhenti coba bikin ubah rusak curi menang'),
  decimalSep: ',',
  parseNumber,
  formatNumber,
};
