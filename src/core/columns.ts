// Maps any spreadsheet's headers onto canonical field names, and back again for export.
// Supports the Maps Directory Collector's export, Outscraper and Apify (Google Maps scraper) out of the box.
import type { Row } from './types.js';

export interface FieldDef { key: string; label: string; width: number; aliases: string[] }

/** Canonical fields, in export order. Labels match the collector's Excel export. */
export const FIELDS: FieldDef[] = [
  { key: 'name', label: 'Business Name', width: 34, aliases: ['name', 'title', 'business name', 'company', 'company name', 'business'] },
  { key: 'rating', label: 'Google Rating', width: 14, aliases: ['rating', 'totalscore', 'total score', 'stars', 'google rating'] },
  { key: 'review_count', label: 'Google Review Count', width: 14, aliases: ['reviews', 'reviewscount', 'reviews count', 'review count', 'google review count', 'user_ratings_total'] },
  { key: 'phone', label: 'Phone Number', width: 20, aliases: ['phone', 'phone number', 'phone_number', 'telephone', 'phoneunformatted'] },
  { key: 'website', label: 'Website', width: 40, aliases: ['website', 'site', 'url website', 'web', 'domain', 'website url'] },
  { key: 'address', label: 'Address', width: 50, aliases: ['address', 'full_address', 'full address', 'formatted_address', 'street address'] },
  { key: 'city', label: 'City', width: 20, aliases: ['city', 'town', 'locality'] },
  { key: 'state', label: 'State', width: 12, aliases: ['state', 'us_state', 'region', 'county/state', 'province'] },
  { key: 'postal_code', label: 'ZIP Code', width: 12, aliases: ['zip', 'zip code', 'postal_code', 'postal code', 'postalcode', 'postcode'] },
  { key: 'county', label: 'County', width: 18, aliases: ['county'] },
  { key: 'service_area_business', label: 'Service-Area Business', width: 14, aliases: ['service-area business', 'service area business'] },
  { key: 'service_area_text', label: 'Service Areas', width: 30, aliases: ['service areas', 'service area', 'areas served'] },
  { key: 'category', label: 'Category', width: 26, aliases: ['category', 'categoryname', 'category name', 'type', 'main category', 'main_category'] },
  { key: 'categories', label: 'All Categories', width: 30, aliases: ['subtypes', 'categories', 'all categories'] },
  { key: 'provider_type', label: 'Provider Type', width: 16, aliases: ['provider type'] },
  { key: 'services_offered', label: 'Services Offered', width: 24, aliases: ['services offered', 'shelter types'] },
  { key: 'business_status', label: 'Business Status', width: 18, aliases: ['business status', 'business_status', 'status', 'permanentlyclosed', 'permanently closed', 'temporarilyclosed'] },
  { key: 'working_hours', label: 'Working Hours', width: 40, aliases: ['working hours', 'working_hours', 'hours', 'opening hours', 'openinghours'] },
  { key: 'place_id', label: 'Google Place ID', width: 30, aliases: ['place_id', 'placeid', 'google place id', 'place id'] },
  { key: 'place_key', label: 'Maps Identifier', width: 30, aliases: ['maps identifier', 'google_id', 'cid', 'fid', 'feature id'] },
  { key: 'maps_url', label: 'Maps URL', width: 40, aliases: ['maps url', 'location_link', 'url', 'google maps url', 'maps link', 'link'] },
  { key: 'search_term', label: 'Search Query', width: 28, aliases: ['search query', 'query', 'searchstring', 'search string', 'keyword', 'search term'] },
  { key: 'search_location', label: 'Search Location', width: 24, aliases: ['search location', 'location', 'searched location'] },
  { key: 'collected_at', label: 'Date Collected', width: 16, aliases: ['date collected', 'scrapedat', 'scraped at'] },
  { key: 'verified_at', label: 'Date Verified', width: 16, aliases: ['date verified'] }
];

export const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/** Output columns added by earlier runs; dropped on import so a re-run starts clean. */
const RESULT_HEADERS = new Set(['no.', 'result', 'reason', 'website check', 'keyword score', 'jev: supplies', 'business role', 'serves area', 'services',
  'email', 'contact page', 'other emails', 'email check']);

export interface ColumnMapping {
  /** header -> canonical key ('' = pass through untouched under its own header) */
  byHeader: Record<string, string>;
  /** canonical key -> header it came from */
  byKey: Record<string, string>;
  /** headers kept as extra columns */
  extras: string[];
}

/**
 * Works out which column holds which field. `overrides` maps canonical keys to header names
 * (e.g. {website: 'Company URL'}) and always wins.
 */
export function detectMapping(headers: string[], overrides: Record<string, string> = {}): ColumnMapping {
  const byHeader: Record<string, string> = {}, byKey: Record<string, string> = {};
  const overrideHeaders = new Map(Object.entries(overrides).map(([k, h]) => [norm(h), k]));
  for (const h of headers) {
    const n = norm(h);
    const forced = overrideHeaders.get(n);
    if (forced) { byHeader[h] = forced; byKey[forced] = h; }
  }
  for (const f of FIELDS) {
    if (byKey[f.key]) continue;
    // Exact label first, then aliases in priority order.
    const candidates = [norm(f.label), ...f.aliases.map(norm)];
    for (const c of candidates) {
      const h = headers.find(x => norm(x) === c && !byHeader[x]);
      if (h) { byHeader[h] = f.key; byKey[f.key] = h; break; }
    }
  }
  const extras = headers.filter(h => !byHeader[h] && !RESULT_HEADERS.has(norm(h)) && h.trim() !== '');
  return { byHeader, byKey, extras };
}

/** Normalises values that different scrapers write differently. */
function normaliseValue(key: string, value: string, header: string): string {
  if (key === 'business_status') {
    const h = norm(header);
    if (h === 'permanentlyclosed' || h === 'permanently closed') return /^(true|1|yes)$/i.test(value) ? 'Permanently closed' : '';
    if (h === 'temporarilyclosed') return /^(true|1|yes)$/i.test(value) ? 'Temporarily closed' : '';
    if (/CLOSED_PERMANENTLY/i.test(value)) return 'Permanently closed';
    if (/CLOSED_TEMPORARILY/i.test(value)) return 'Temporarily closed';
    if (/^OPERATIONAL$/i.test(value)) return 'Operational';
  }
  if (key === 'category' && value.includes(',') && norm(header) === 'type') return value.split(',')[0].trim();
  return value;
}

/** Table (first row = headers) -> rows with canonical keys plus extra columns under `extra:<header>`. */
export function tableToRows(table: unknown[][], overrides: Record<string, string> = {}): { rows: Row[]; mapping: ColumnMapping; headers: string[] } {
  const headers = (table[0] || []).map(h => String(h ?? '').trim());
  const mapping = detectMapping(headers, overrides);
  const rows: Row[] = [];
  for (const line of table.slice(1)) {
    if (!line || !line.some(v => String(v ?? '').trim())) continue;
    const row: Row = {};
    headers.forEach((h, i) => {
      const raw = line[i] instanceof Date ? (line[i] as Date).toISOString() : String(line[i] ?? '');
      const key = mapping.byHeader[h];
      if (key) row[key] = normaliseValue(key, raw, h);
      else if (mapping.extras.includes(h)) row['extra:' + h] = raw;
    });
    rows.push(row);
  }
  return { rows, mapping, headers };
}
