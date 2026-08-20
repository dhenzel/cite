// Minimal .xlsx reader — enough to read a generated workbook, no dependencies.
//
// Written because the research workbook is ClosedXML output: every element
// carries an `x:` namespace prefix (`<x:worksheet>`, `<x:c>`, `<x:v>`), which
// ExcelJS's parser does not accept (it looks for unprefixed <workbook>/<sheets>
// and ends up with `workbook.sheets === undefined`). SheetJS handles prefixes
// but the npm build is pinned at 0.18.5 with an open prototype-pollution
// advisory, and this runs over a file a human hands us.
//
// Scope on purpose: deflate/stored ZIP entries, shared + inline + literal
// strings, numbers, and Excel date serials. No formulas, styles, merges or
// streaming. The XML is machine-generated and uniform, so regex parsing is
// safe here in a way it would not be for arbitrary user XML.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------- ZIP ----------
interface Entry { name: string; offset: number; compressed: number; size: number; method: number }

function centralDirectory(buf: Buffer): Map<string, Entry> {
  // End of central directory: scan back from the tail for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { name, offset, compressed, size, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function read(buf: Buffer, e: Entry): string {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`corrupt local header for ${e.name}`);
  // Local header name/extra lengths can differ from the central directory's.
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return raw.toString('utf8');
  if (e.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
}

// ---------- XML ----------
const unescapeXml = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** Matches <tag …> or <x:tag …>, the only namespace shape these files use. */
const tag = (name: string) => `(?:\\w+:)?${name}`;

/** Excel serial → ISO date. Day 1 is 1900-01-01, with the 1900 leap-year bug. */
function serialToDate(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** Column letters → zero-based index: A→0, Z→25, AA→26. */
function columnIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface Sheet { name: string; rows: string[][] }

/**
 * Read every worksheet as a dense grid of strings.
 * `dateColumns` names headers whose numeric values are Excel date serials —
 * without style parsing there is no other way to tell 45889 from a count.
 */
export function readWorkbook(path: string, dateColumns: RegExp = /date|checked|updated/i): Sheet[] {
  const buf = readFileSync(path);
  const entries = centralDirectory(buf);

  const workbookXml = entries.get('xl/workbook.xml');
  if (!workbookXml) throw new Error('xl/workbook.xml missing — not an xlsx file');

  // Sheet order in workbook.xml matches sheet1.xml, sheet2.xml, … as written by
  // every generator we have seen; the r:id → target mapping in workbook.xml.rels
  // is the strict form, so use it when present.
  const names: string[] = [];
  const ids: string[] = [];
  const sheetRe = new RegExp(`<${tag('sheet')}\\s[^>]*?name="([^"]*)"[^>]*?>`, 'g');
  const xml = read(buf, workbookXml);
  for (const m of xml.matchAll(sheetRe)) {
    names.push(unescapeXml(m[1]));
    ids.push(/r:id="([^"]*)"/.exec(m[0])?.[1] ?? '');
  }

  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (relsEntry) {
    const rels = read(buf, relsEntry);
    for (const m of rels.matchAll(/<(?:\w+:)?Relationship\s[^>]*?>/g)) {
      const id = /Id="([^"]*)"/.exec(m[0])?.[1];
      const target = /Target="([^"]*)"/.exec(m[0])?.[1];
      if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
  }

  // Shared strings, when the generator uses them.
  const sstEntry = entries.get('xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sstEntry) {
    const sst = read(buf, sstEntry);
    for (const si of sst.matchAll(new RegExp(`<${tag('si')}>([\\s\\S]*?)</${tag('si')}>`, 'g'))) {
      const parts = [...si[1].matchAll(new RegExp(`<${tag('t')}[^>]*>([\\s\\S]*?)</${tag('t')}>`, 'g'))];
      shared.push(unescapeXml(parts.map((p) => p[1]).join('')));
    }
  }

  const rowRe = new RegExp(`<${tag('row')}[^>]*>([\\s\\S]*?)</${tag('row')}>`, 'g');
  const cellRe = new RegExp(`<${tag('c')}\\s([^>]*?)(?:/>|>([\\s\\S]*?)</${tag('c')}>)`, 'g');
  const valueRe = new RegExp(`<${tag('v')}[^>]*>([\\s\\S]*?)</${tag('v')}>`);
  const inlineRe = new RegExp(`<${tag('t')}[^>]*>([\\s\\S]*?)</${tag('t')}>`);

  const sheets: Sheet[] = [];
  names.forEach((name, i) => {
    const target = targets.get(ids[i]) ?? `worksheets/sheet${i + 1}.xml`;
    const entry = entries.get(`xl/${target}`);
    if (!entry) return;
    const sheetXml = read(buf, entry);
    const rows: string[][] = [];
    let dateCols = new Set<number>();

    for (const rowMatch of sheetXml.matchAll(rowRe)) {
      const cells: string[] = [];
      for (const c of rowMatch[1].matchAll(cellRe)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const at = ref ? columnIndex(ref) : cells.length;
        const type = /t="([^"]*)"/.exec(attrs)?.[1];
        let value = '';
        if (type === 'inlineStr') {
          value = unescapeXml(inlineRe.exec(body)?.[1] ?? '');
        } else {
          const raw = valueRe.exec(body)?.[1] ?? '';
          if (type === 's') value = shared[Number(raw)] ?? '';
          else value = unescapeXml(raw);
        }
        // Numeric cell in a column whose header looks like a date. ClosedXML
        // writes these as t="n"; other generators leave the type off entirely.
        if ((!type || type === 'n') && value && dateCols.has(at) && Number.isFinite(Number(value))) {
          value = serialToDate(Number(value));
        }
        while (cells.length < at) cells.push('');
        cells[at] = value.trim();
      }
      // The first non-empty row names the columns; remember which are dates.
      if (!rows.length && cells.some((v) => v !== '')) {
        dateCols = new Set(cells.map((v, idx) => (dateColumns.test(v) ? idx : -1)).filter((idx) => idx >= 0));
      }
      rows.push(cells);
    }
    sheets.push({ name, rows });
  });
  return sheets;
}
