/**
 * A small RFC 4180 CSV reader for uploads: UTF-8 byte-order mark, CRLF / LF / lone CR line ends, quoted fields with embedded commas, line breaks and doubled quotes,
 * `;` or tab as the delimiter when the header line has no comma. Strict about structure: an unterminated quote or a stray quote inside an unquoted field is an error
 * with the line number, never a silently shifted column.
 */
export class CsvError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export interface ParsedCsv {
  header: string[];
  rows: { line: number; cells: string[] }[];
  delimiter: string;
}

export function parseCsv(input: string, opts: { maxRows?: number } = {}): ParsedCsv {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  text = text.replace(/\r\n?/g, '\n');
  const firstLine = text.split('\n', 1)[0] ?? '';
  const delimiter = firstLine.includes(',') ? ',' : firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;
  const endField = () => {
    cells.push(cell);
    cell = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: recordLine, cells });
    cells = [];
    if (opts.maxRows !== undefined && records.length > opts.maxRows + 1) throw new CsvError(`The file has more than ${opts.maxRows} rows`, line);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          const next = text[i + 1];
          if (next !== undefined && next !== delimiter && next !== '\n') throw new CsvError('A closing quote must be followed by a separator or the end of the line', line);
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) throw new CsvError('A quote inside an unquoted field: put the whole field in quotes and double the inner quote', line);
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) endField();
    else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      fieldStarted = true;
      cell += ch;
    }
  }
  if (quoted) throw new CsvError('A quoted field is never closed', recordLine);
  if (fieldStarted || cell !== '' || cells.length) endRecord();
  const [head, ...rows] = records;
  if (!head) throw new CsvError('The file is empty', 1);
  return { header: head.cells.map((h) => h.trim()), rows, delimiter };
}
