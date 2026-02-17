export interface ToonTable {
  name: string;
  expectedRows: number;
  delimiter: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

interface HeaderInfo {
  name: string;
  expectedRows: number;
  delimiter: string;
  columns: string[];
  tail?: string;
  bracketValues?: string[];
}

function canonicalTableName(name: string): string {
  const normalized = (name ?? '').trim().toLowerCase();
  if (normalized === 'link') return 'links';
  if (normalized === 'fact') return 'facts';
  return normalized;
}

function normalize(text: string): string {
  let out = (text ?? '').trim();
  if (!out) return '';
  if (out.startsWith('"') && out.endsWith('"')) {
    try {
      const parsed = JSON.parse(out);
      if (typeof parsed === 'string') {
        out = parsed.trim();
      }
    } catch {
      // ignore
    }
  }
  const fenced = out.match(/```(?:toon|json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    out = fenced[1].trim();
  }
  return out;
}

function parseHeader(line: string): HeaderInfo | null {
  const match = line.match(/^([a-zA-Z_]\w*)(?:\[(.*?)\])?(?:\{([^}]*)\})?:?\s*(.*)$/);
  if (!match) return null;
  const name = (match[1] ?? '').trim();
  if (!name) return null;
  const tail = (match[4] ?? '').trim();
  const rawBracketToken = (match[2] ?? '').trim();
  let delimiter: string = ',';
  let rawRowsToken = rawBracketToken;
  if (rawRowsToken) {
    const lastChar = rawRowsToken[rawRowsToken.length - 1] ?? '';
    if (lastChar === ',' || lastChar === '\t' || lastChar === '|' || lastChar === ';') {
      delimiter = lastChar;
      rawRowsToken = rawRowsToken.slice(0, -1).trim();
    }
  }
  let rowsToken = rawRowsToken;
  let inlineColumnsFromBracket = '';
  if (!match[3] && rowsToken.includes('{') && rowsToken.includes('}')) {
    const open = rowsToken.indexOf('{');
    const close = rowsToken.lastIndexOf('}');
    if (open >= 0 && close > open) {
      inlineColumnsFromBracket = rowsToken.slice(open + 1, close).trim();
      rowsToken = rowsToken.slice(0, open).replace(/[,;:\s]+$/g, '').trim();
    }
  }
  const expectedRows = rowsToken === '' || !/^\d+$/.test(rowsToken)
    ? -1
    : Number(rowsToken);
  const columnsRaw = (match[3] ?? '').trim() || inlineColumnsFromBracket;
  const columnsDelimiter = columnsRaw.includes(delimiter) ? delimiter : ',';
  const columns = columnsRaw
    ? parseDelimitedRow(columnsRaw, columnsDelimiter).map(c => c.trim()).filter(Boolean)
    : [];
  let bracketValues: string[] | undefined;
  if (columns.length === 0 && rawRowsToken.includes(',') && !rawRowsToken.includes('{')) {
    const vals = parseDelimitedRow(rawRowsToken, ',').map(v => v.trim()).filter(Boolean);
    if (vals.length >= 4) {
      bracketValues = vals;
    }
  }
  return { name, expectedRows, delimiter, columns, tail, bracketValues };
}

function unescapeQuoted(value: string): string {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

function parseObjectLikeRow(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // keep fallback
  }

  const body = trimmed.slice(1, -1);
  const out: Record<string, unknown> = {};
  const parts = body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  for (const part of parts) {
    const kv = part.split(':');
    if (kv.length < 2) continue;
    const key = kv[0]?.trim().replace(/^["']|["']$/g, '');
    const valueRaw = kv.slice(1).join(':').trim();
    if (!key) continue;
    out[key] = valueRaw.replace(/^["']|["']$/g, '');
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseBracketRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return parseDelimitedRow(inner, ',');
}

function parseKeyValueLine(line: string): { key: string; value: string } | null {
  const clean = line.trim().replace(/,$/, '').trim();
  if (!clean || clean === '{' || clean === '}') return null;
  const idx = clean.indexOf(':');
  if (idx <= 0) return null;
  const key = clean.slice(0, idx).trim().replace(/^["']|["']$/g, '');
  const value = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  if (!key) return null;
  return { key, value };
}

export function parseDelimitedRow(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!ch) continue;
    if (ch === '"' && line[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  values.push(current.trim());

  return values.map(value => {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      return unescapeQuoted(trimmed.slice(1, -1));
    }
    return trimmed;
  });
}

export function parseToonTables(text: string, requiredTables: string[]): Record<string, ToonTable> {
  const payload = normalize(text);
  if (!payload) {
    throw new Error('TOON payload is empty.');
  }

  const lines = payload.split(/\r?\n/);
  const out: Record<string, ToonTable> = {};
  const inlineHeaderRowsSeen: Record<string, boolean> = {};
  let current: ToonTable | null = null;
  let pendingObjectRow: Record<string, unknown> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (current && current.columns.length === 0 && pendingObjectRow) {
      if (line === '}') {
        if (Object.keys(pendingObjectRow).length > 0) {
          current.rows.push(pendingObjectRow);
        }
        pendingObjectRow = null;
        continue;
      }
      const kv = parseKeyValueLine(line);
      if (kv) {
        pendingObjectRow[kv.key] = kv.value;
        continue;
      }
    }

    const header = parseHeader(line);
    if (header) {
      const tableName = canonicalTableName(header.name);
      const existing = out[tableName];
      if (existing) {
        current = existing;
        if (current.columns.length === 0 && header.columns.length > 0) {
          current.columns = header.columns;
        }
        if (header.expectedRows >= 0) {
          if (current.expectedRows < 0) {
            current.expectedRows = header.expectedRows;
          } else if (current.expectedRows !== header.expectedRows) {
            // Some TOON producers emit table headers per row (facts[0,], facts[1,], ...).
            // In that mode the bracket number is not a total row count, so disable strict count check.
            current.expectedRows = -1;
          }
        }
      } else {
        current = {
          name: tableName,
          expectedRows: header.expectedRows,
          delimiter: header.delimiter,
          columns: header.columns,
          rows: [],
        };
        out[current.name] = current;
      }

      if (current.columns.length === 0 && current.name === 'links' && header.bracketValues && header.bracketValues.length >= 4) {
        current.rows.push({
          fromId: header.bracketValues[0] ?? '',
          toId: header.bracketValues[1] ?? '',
          relation: header.bracketValues[2] ?? '',
          confidence: header.bracketValues[3] ?? '',
        });
        inlineHeaderRowsSeen[current.name] = true;
        continue;
      }

      const inlineRow = (header.tail ?? '').replace(/;$/, '').trim();
      if (!inlineRow) {
        continue;
      }
      inlineHeaderRowsSeen[current.name] = true;

      const objectLike = parseObjectLikeRow(inlineRow);
      if (objectLike) {
        current.rows.push(objectLike);
        continue;
      }
      if (current.columns.length === 0) {
        if (inlineRow === '{') {
          pendingObjectRow = {};
          continue;
        }
        const bracketRow = parseBracketRow(inlineRow);
        if (bracketRow && current.name === 'links' && bracketRow.length >= 4) {
          const row: Record<string, unknown> = {
            fromId: bracketRow[0] ?? '',
            toId: bracketRow[1] ?? '',
            relation: bracketRow[2] ?? '',
            confidence: bracketRow[3] ?? '',
          };
          current.rows.push(row);
          continue;
        }
      }
      if (current.columns.length === 0) {
        throw new Error(`TOON table "${current.name}" has inline row but no columns in header.`);
      }
      const values = parseDelimitedRow(inlineRow, current.delimiter);
      const row: Record<string, unknown> = {};
      for (let i = 0; i < current.columns.length; i++) {
        const key = current.columns[i];
        if (!key) continue;
        row[key] = values[i] ?? '';
      }
      current.rows.push(row);
      continue;
    }

    if (!current) continue;
    const cleanLine = line.replace(/;$/, '').trim();
    if (!cleanLine) continue;

    const objectLike = parseObjectLikeRow(cleanLine);
    if (objectLike) {
      current.rows.push(objectLike);
      continue;
    }

    if (current.columns.length === 0) {
      if (cleanLine === '{') {
        pendingObjectRow = {};
        continue;
      }
      if (pendingObjectRow) {
        if (cleanLine === '}') {
          if (Object.keys(pendingObjectRow).length > 0) {
            current.rows.push(pendingObjectRow);
          }
          pendingObjectRow = null;
          continue;
        }
        const kv = parseKeyValueLine(cleanLine);
        if (kv) {
          pendingObjectRow[kv.key] = kv.value;
          continue;
        }
      }
      throw new Error(`TOON table "${current.name}" has rows but no columns in header.`);
    }

    const values = parseDelimitedRow(cleanLine, current.delimiter);
    const row: Record<string, unknown> = {};
    for (let i = 0; i < current.columns.length; i++) {
      const key = current.columns[i];
      if (!key) continue;
      row[key] = values[i] ?? '';
    }
    current.rows.push(row);
  }

  if (pendingObjectRow && current && Object.keys(pendingObjectRow).length > 0) {
    current.rows.push(pendingObjectRow);
  }

  for (const tableName of requiredTables) {
    const table = out[tableName];
    if (!table) {
      throw new Error(`TOON table "${tableName}" is missing.`);
    }
  }

  return out;
}
