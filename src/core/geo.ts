// Distance from a business to the nearest part of a target area (US only for now), using ZIP code
// centres from the offline `zipcodes` package. Used to rank Review, never to decide on its own.
import { createRequire } from 'node:module';
import { areaCode, US_STATES } from './area.js';
import type { Row } from './types.js';

interface Zip { zip: string; latitude: number; longitude: number; city: string; state: string; country: string }
let codes: Record<string, Zip> | null = null;
const byState = new Map<string, Zip[]>();

function data(): Record<string, Zip> {
  if (!codes) {
    const require = createRequire(import.meta.url);
    codes = (require('zipcodes') as { codes: Record<string, Zip> }).codes;
  }
  return codes;
}

function zipsIn(state: string): Zip[] {
  if (!byState.has(state)) byState.set(state, Object.values(data()).filter(z => z.country === 'US' && z.state === state && z.latitude));
  return byState.get(state)!;
}

/** Great-circle distance in miles. */
export function miles(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180, R = 3958.8;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The business's US ZIP code, from its ZIP field or the end of its address. */
export function rowZip(row: Row): string {
  const own = String(row.postal_code || '').match(/^\d{5}/)?.[0];
  if (own) return own;
  return String(row.address || '').match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?(?:,\s*(?:USA|United States))?\s*$/)?.[1] || '';
}

const cache = new Map<string, number | null>();

/**
 * Miles from the business's ZIP centre to the nearest ZIP centre in the target US state.
 * 0 when it is inside the state; null when unknown (no ZIP, UK target, etc.).
 */
export function milesFromArea(row: Row, area: string): number | null {
  if (!area || !US_STATES[area]) return null;
  const zip = rowZip(row);
  if (!zip) return null;
  const key = zip + '|' + area;
  if (cache.has(key)) return cache.get(key)!;
  const here = data()[zip];
  let result: number | null = null;
  if (here?.latitude) {
    if (here.state === area) result = 0;
    else {
      let best = Infinity;
      for (const z of zipsIn(area)) { const d = miles(here, z); if (d < best) best = d; }
      result = Number.isFinite(best) ? Math.round(best) : null;
    }
  }
  cache.set(key, result);
  return result;
}

let areaCodes: Record<string, string> | null = null;

/**
 * Area from the phone number: US area codes (620 -> KS), Northern Ireland landlines (028 -> NIR),
 * Republic of Ireland (+353 -> IRL). '' when unknown, toll-free, mobile or elsewhere.
 */
export function phoneArea(row: Row): string {
  const raw = String(row.phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^\+?44/.test(raw.replace(/[\s()-]/g, '')) || /^0\d/.test(digits)) {
    const national = digits.replace(/^44/, '0');
    return /^028/.test(national) ? 'NIR' : '';
  }
  if (/^\+?353/.test(raw.replace(/[\s()-]/g, ''))) return 'IRL';
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return '';
  if (!areaCodes) {
    const require = createRequire(import.meta.url);
    areaCodes = (require('../data/area-codes.json') as { codes: Record<string, string> }).codes;
  }
  const state = areaCodes[ten.slice(0, 3)];
  const code = state ? areaCode(state) : '';
  return code && US_STATES[code] ? code : '';
}
