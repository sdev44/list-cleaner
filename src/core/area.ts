// Target areas: US states and UK nations. Ported from the extension's cleaner-engine.js.
import type { Row } from './types.js';

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};
/** UK nations use 3-letter codes so they never clash with US state codes. "UK" means any nation. */
export const UK_NATIONS: Record<string, string> = { UK: 'United Kingdom', ENG: 'England', SCT: 'Scotland', WLS: 'Wales', NIR: 'Northern Ireland' };
export const AREAS: Record<string, string> = { ...US_STATES, ...UK_NATIONS };

export const regionName = (code: string): string => AREAS[code] || code || '';

/** Does a business's state/nation count as inside the target area? */
export const sameArea = (code: string, target: string): boolean =>
  !!code && (code === target || (target === 'UK' && ['ENG', 'SCT', 'WLS', 'NIR'].includes(code)));

/** "Kansas", "KS", "Kansas, USA", "UK" -> area code, or ''. */
export function areaCode(value: unknown): string {
  if (/^\s*(UK|United Kingdom)\s*$/i.test(String(value || ''))) return 'UK';
  const v = String(value || '').replace(/,?\s*(USA|United States|UK|United Kingdom)$/i, '').trim();
  return Object.keys(AREAS).find(k => k === v.toUpperCase() || AREAS[k].toLowerCase() === v.toLowerCase()) || '';
}

/** UK postcode -> nation, by postcode area (border districts approximated). */
export function ukNation(address: unknown): string {
  const m = String(address || '').toUpperCase().match(/\b([A-Z]{1,2})(\d{1,2})[A-Z]?\s*\d[A-Z]{2}\b/);
  if (!m) return /\b(UK|United Kingdom)\s*$/i.test(String(address || '')) ? 'UK' : '';
  const area = m[1], district = Number(m[2]);
  if (area === 'BT') return 'NIR';
  if (['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'ZE'].includes(area) || (area === 'TD' && district <= 14)) return 'SCT';
  if (['CF', 'LD', 'LL', 'NP', 'SA'].includes(area) || (area === 'SY' && district >= 15)) return 'WLS';
  return 'ENG';
}

/** The business's own state/nation, from its State field or address. */
export function rowArea(row: Row): string {
  if (row.state && areaCode(row.state)) return areaCode(row.state);
  const address = String(row.address || '');
  const m = address.match(/,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?(?:,\s*(?:USA|United States))?\s*$/);
  if (m && US_STATES[m[1]]) return m[1];
  const uk = ukNation(address);
  return uk && uk !== 'UK' ? uk : '';
}

/** Most common area among rows that have one. */
export function guessArea(rows: Row[]): string {
  const counts: Record<string, number> = {};
  for (const row of rows) { const s = rowArea(row); if (s) counts[s] = (counts[s] || 0) + 1; }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/** True when the business turned up in searches for the target area. */
export function searchedInArea(row: Row, target: string): boolean {
  if (!target) return false;
  if (target === 'UK') return /\b(UK|United Kingdom)\b/.test(row.search_location || '');
  const name = regionName(target);
  return new RegExp('\\b(' + name + '|' + target + ')\\b', 'i').test(row.search_location || '');
}

/** In the area by address, or (with no address) found by searches for the area. */
export const inArea = (row: Row, target: string): boolean =>
  sameArea(rowArea(row), target) || (!rowArea(row) && searchedInArea(row, target));
