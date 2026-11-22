// Builds the output workbook: one sheet per outcome plus a summary.
import { FIELDS, type ColumnMapping } from './columns.js';
import { writeCsv, writeWorkbook, type SheetSpec } from './io.js';
import type { RowResult } from './pipeline.js';
import type { Template } from './template.js';
import type { Outcome, Row } from './types.js';

const LINK_KEYS = new Set(['website', 'maps_url']);
const NUMBER_KEYS = new Set(['rating', 'review_count']);

export function buildColumns(mapping: ColumnMapping, template: Template) {
  const business = FIELDS.filter(f => mapping.byKey[f.key]).map(f => ({ key: f.key, header: f.label, width: f.width, link: LINK_KEYS.has(f.key), number: NUMBER_KEYS.has(f.key) }));
  const extras = mapping.extras.map(h => ({ key: 'extra:' + h, header: h, width: Math.min(40, Math.max(12, h.length + 2)), link: false, number: false }));
  return [
    { key: '#no', header: 'No.', width: 7, link: false, number: true },
    ...business.slice(0, 1),
    { key: '#result', header: 'Result', width: 11, link: false, number: false },
    { key: '#reason', header: 'Reason', width: 60, link: false, number: false },
    ...business.slice(1),
    ...extras,
    ...template.columns.map(c => ({ link: false, number: false, ...c }))
  ];
}

export function exportRows(rows: Row[], results: (RowResult | null)[], mapping: ColumnMapping, template: Template, only?: Outcome | 'all') {
  const columns = buildColumns(mapping, template);
  const out: (string | number)[][] = [];
  rows.forEach((row, i) => {
    const r = results[i];
    if (only && only !== 'all' && r?.outcome !== only) return;
    out.push(columns.map(c => {
      if (c.key === '#no') return out.length + 1;
      if (c.key === '#result') return r ? template.outcomeLabels[r.outcome] : 'Not checked';
      if (c.key === '#reason') return r?.reason || '';
      if (r?.fields && c.key in r.fields) return r.fields[c.key];
      return row[c.key] ?? '';
    }));
  });
  return { columns, rows: out };
}

export async function writeResults(path: string, rows: Row[], results: (RowResult | null)[], mapping: ColumnMapping, template: Template, summary: [string, string | number][]) {
  if (path.toLowerCase().endsWith('.csv')) {
    const all = exportRows(rows, results, mapping, template, 'all');
    await writeCsv(path, all.columns.map(c => c.header), all.rows);
    return;
  }
  const sheets: SheetSpec[] = (['keep', 'review', 'remove'] as Outcome[]).map(o => {
    const part = exportRows(rows, results, mapping, template, o);
    return { name: template.outcomeLabels[o], columns: part.columns, rows: part.rows };
  });
  if (results.some(r => !r)) {
    const columns = buildColumns(mapping, template);
    const pending = rows.map((row, i) => ({ row, i })).filter(x => !results[x.i]);
    sheets.push({ name: 'Not checked', columns, rows: pending.map(({ row }, n) => columns.map(c => c.key === '#no' ? n + 1 : c.key === '#result' ? 'Not checked' : row[c.key] ?? '')) });
  }
  sheets.push({ name: 'Summary', columns: [{ header: 'Item', width: 34 }, { header: 'Value', width: 60 }], rows: summary.map(([k, v]) => [k, v]) });
  await writeWorkbook(path, sheets);
}
