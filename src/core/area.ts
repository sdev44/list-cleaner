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
/** Places recognised only so they count as outside a UK/US target (never a target themselves yet). */
export const OTHER_AREAS: Record<string, string> = { IRL: 'Republic of Ireland' };
export const AREAS: Record<string, string> = { ...US_STATES, ...UK_NATIONS };

export const regionName = (code: string): string => AREAS[code] || OTHER_AREAS[code] || code || '';

/** Does a business's state/nation count as inside the target area? */
export const sameArea = (code: string, target: string): boolean =>
  !!code && (code === target || (target === 'UK' && ['ENG', 'SCT', 'WLS', 'NIR'].includes(code)));

/** "Kansas", "KS", "Kansas, USA", "UK" -> area code, or ''. */
export function areaCode(value: unknown): string {
  if (/^\s*(UK|United Kingdom)\s*$/i.test(String(value || ''))) return 'UK';
  const v = String(value || '').replace(/,?\s*(USA|United States|UK|United Kingdom)$/i, '').trim();
  return Object.keys(AREAS).find(k => k === v.toUpperCase() || AREAS[k].toLowerCase() === v.toLowerCase()) || '';
}

const nationOfPostcodeArea = (area: string, district: number): string => {
  if (area === 'BT') return 'NIR';
  if (['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'ZE'].includes(area) || (area === 'TD' && district <= 14)) return 'SCT';
  if (['CF', 'LD', 'LL', 'NP', 'SA'].includes(area) || (area === 'SY' && district >= 15)) return 'WLS';
  return 'ENG';
};

/** UK postcode -> nation, by postcode area (border districts approximated). Also reads part postcodes and nation names. */
export function ukNation(address: unknown): string {
  const a = String(address || '');
  const upper = a.toUpperCase();
  const full = upper.match(/\b([A-Z]{1,2})(\d{1,2})[A-Z]?\s*\d[A-Z]{2}\b/);
  if (full) return nationOfPostcodeArea(full[1], Number(full[2]));
  const isUk = /\b(UK|United Kingdom|Great Britain|Northern Ireland|England|Scotland|Wales)\s*$/i.test(a.replace(/,\s*$/, ''));
  // Part postcode ("Dundonald, Northern Ireland BT18, United Kingdom") in a UK address.
  const part = isUk ? upper.match(/(?:^|[\s,])([A-Z]{1,2})(\d{1,2})[A-Z]?(?=\s*(?:,|$))/) : null;
  if (part && /^(BT|[A-Z]{1,2})$/.test(part[1]) && part[1] !== 'UK') return nationOfPostcodeArea(part[1], Number(part[2]));
  if (/\bNorthern Ireland\b/i.test(a)) return 'NIR';
  if (/\bScotland\b/i.test(a)) return 'SCT';
  if (/\bWales\b/i.test(a) && !/New South Wales/i.test(a)) return 'WLS';
  if (/\bEngland\b/i.test(a)) return 'ENG';
  return isUk ? 'UK' : '';
}

/** Republic of Ireland address: an Eircode, or ending "Ireland" without "Northern". */
export function isIrelandAddress(address: unknown): boolean {
  const a = String(address || '').trim();
  if (/\bNorthern Ireland\b/i.test(a)) return false;
  return /\b[AC-FHKNPRTV-Y]\d{2}\s?[0-9AC-FHKNPRTV-Y]{4}\b/i.test(a) || /,\s*(Ireland|Éire|Eire|IE)\s*$/i.test(a) || /\bCo\.\s+[A-Z][a-z]+/.test(a);
}

/** The business's own state/nation, from its State field or address. */
export function rowArea(row: Row): string {
  if (row.state && areaCode(row.state)) return areaCode(row.state);
  const address = String(row.address || '');
  const m = address.match(/,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?(?:,\s*(?:USA|United States))?\s*$/);
  if (m && US_STATES[m[1]]) return m[1];
  const uk = ukNation(address);
  if (uk && uk !== 'UK') return uk;
  return isIrelandAddress(address) ? 'IRL' : '';
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

/** Republic of Ireland counties on the Northern Ireland border (Donegal, Leitrim, Cavan, Monaghan, Louth). */
export function nearNorthernIreland(address: unknown): boolean {
  const a = String(address || '');
  return /\b(Co\.?|County)\s+(Donegal|Leitrim|Cavan|Monaghan|Louth)\b/i.test(a)
    || /\b(Donegal|Letterkenny|Buncrana|Lifford|Bundoran|Ballyshannon|Moville|Carndonagh|Manorhamilton|Cavan|Cootehill|Belturbet|Bailieborough|Monaghan|Clones|Carrickmacross|Castleblayney|Dundalk|Drogheda|Ardee|Carlingford)\b/i.test(a)
    || /\b(F93|F92|F94|H12|H14|H16|H18|H23|A75|A81|A91|A92)\s?[0-9A-Z]{4}\b/i.test(a);
}
