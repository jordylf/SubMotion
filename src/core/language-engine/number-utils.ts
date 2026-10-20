// Kept separate from index.ts so language packs can import it without an import cycle.

/** Shared helpers for language number parsers. */
export function parseDigits(s: string, decimalSep: ',' | '.'): number | null {
  if (!/^\d+([.,]\d+)*$/.test(s)) return null;
  const thousands = decimalSep === ',' ? '.' : ',';
  // "50.000" in id / "50,000" in en are thousands; a single separator followed by 1-2 digits is decimal.
  const parts = s.split(/[.,]/);
  if (parts.length === 2 && s.includes(decimalSep) && parts[1].length !== 3) return Number(parts[0] + '.' + parts[1]);
  if (parts.length === 2 && s.includes(thousands) && parts[1].length !== 3) return Number(parts[0] + '.' + parts[1]);
  return Number(s.replace(/[.,]/g, ''));
}

export function formatDecimal(v: number, sep: ',' | '.'): string {
  return String(Math.round(v * 100) / 100).replace('.', sep);
}

export function groupThousands(v: number, decimalSep: ',' | '.'): string {
  const [int, dec] = String(Math.round(v * 100) / 100).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, decimalSep === ',' ? '.' : ',');
  return dec ? grouped + decimalSep + dec : grouped;
}
