// Reading CSV/XLSX/JSON into tables, and writing result workbooks.
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

/** Plain text of an ExcelJS cell value (hyperlinks, rich text, formulas, dates). */
function cellText(v: ExcelJS.CellValue): string | Date {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('richText' in o) return (o.richText as { text: string }[]).map(r => r.text).join('');
    if ('hyperlink' in o) return String(o.text ?? o.hyperlink ?? '');
    if ('result' in o) return String(o.result ?? '');
    if ('text' in o) return String(o.text ?? '');
    if ('error' in o) return '';
  }
  return String(v);
}

/** Reads the first sheet of an .xlsx, a .csv, or a JSON array of objects. First row = headers. */
export async function readTable(path: string): Promise<unknown[][]> {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
    const rows: string[][] = parseCsv(text, { relax_column_count: true, skip_empty_lines: true, delimiter: lower.endsWith('.tsv') ? '\t' : ',' });
    // Undo spreadsheet formula protection (a leading apostrophe).
    return rows.map(r => r.map(v => v.replace(/^'(?=\s*[=+\-@])/, '')));
  }
  if (lower.endsWith('.json')) {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const list: Record<string, unknown>[] = Array.isArray(data) ? data : data.rows;
    if (!Array.isArray(list)) throw new Error('This JSON file has no list of businesses.');
    const headers = [...new Set(list.flatMap(o => Object.keys(o)))];
    return [headers, ...list.map(o => headers.map(h => {
      const v = o[h];
      return v === null || v === undefined ? '' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : JSON.stringify(v)) : String(v);
    }))];
  }
  if (lower.endsWith('.xlsx')) {
    const sheets = await readSheets(path);
    if (!sheets.length) throw new Error('The workbook has no sheets.');
    return sheets[0].table;
  }
  throw new Error('Unsupported file type. Use .xlsx, .csv, .tsv or .json.');
}

/** Every sheet of an .xlsx as {name, table}. */
export async function readSheets(path: string): Promise<{ name: string; table: unknown[][] }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.worksheets.map(ws => {
    const table: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const values = row.values as ExcelJS.CellValue[]; // 1-based
      const out: unknown[] = [];
      for (let i = 1; i < values.length; i++) out.push(cellText(values[i]));
      table.push(out);
    });
    return { name: ws.name, table };
  });
}

export interface SheetSpec {
  name: string;
  columns: { header: string; width: number; link?: boolean; number?: boolean }[];
  rows: (string | number)[][];
}

const unsafe = /^[=+\-@\t\r]/;

/** Writes a formatted workbook: bold frozen header, filters, clickable links. */
export async function writeWorkbook(path: string, sheets: SheetSpec[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'list-cleaner';
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    ws.columns = spec.columns.map(c => ({ header: c.header, width: c.width }));
    for (const values of spec.rows) {
      const row = ws.addRow(values.map((v, i) => {
        const col = spec.columns[i];
        if (col?.number && v !== '' && !Number.isNaN(Number(v))) return Number(v);
        const s = String(v ?? '');
        if (col?.link && /^https?:\/\//i.test(s)) return { text: s, hyperlink: s };
        return s;
      }));
      row.alignment = { vertical: 'top', wrapText: false };
    }
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    if (spec.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  }
  await wb.xlsx.writeFile(path);
}

/** RFC 4180 CSV with formula protection. */
export async function writeCsv(path: string, header: string[], rows: (string | number)[][]): Promise<void> {
  const esc = (v: string | number) => {
    let s = String(v ?? '');
    if (unsafe.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  await writeFile(path, '﻿' + [header, ...rows].map(r => r.map(esc).join(',')).join('\r\n') + '\r\n', 'utf8');
}
