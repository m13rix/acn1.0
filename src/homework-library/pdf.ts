import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function toUint8Array(data: Uint8Array): Uint8Array {
  if (data instanceof Uint8Array && !(data instanceof Buffer)) {
    return data;
  }
  return new Uint8Array(data);
}

export async function readPdfPageCount(pdfBytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(toUint8Array(pdfBytes));
  return pdf.getPageCount();
}

export async function extractPdfPageRange(
  pdfBytes: Uint8Array,
  startPage: number,
  endPage: number
): Promise<Buffer> {
  const source = await PDFDocument.load(toUint8Array(pdfBytes));
  const pageCount = source.getPageCount();

  const safeStart = Math.max(1, Math.min(pageCount, Math.floor(startPage)));
  const safeEnd = Math.max(safeStart, Math.min(pageCount, Math.floor(endPage)));
  const indices: number[] = [];

  for (let page = safeStart; page <= safeEnd; page += 1) {
    indices.push(page - 1);
  }

  const target = await PDFDocument.create();
  const copiedPages = await target.copyPages(source, indices);
  for (const page of copiedPages) {
    target.addPage(page);
  }

  const output = await target.save();
  return Buffer.from(output);
}

function normalizeFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function extractPdfTextByPageRange(
  pdfBytes: Uint8Array,
  startPage: number,
  endPage: number
): Promise<string> {
  const loadingTask = pdfjsLib.getDocument({
    data: toUint8Array(pdfBytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const maxPage = pdf.numPages;
  const safeStart = Math.max(1, Math.min(maxPage, Math.floor(startPage)));
  const safeEnd = Math.max(safeStart, Math.min(maxPage, Math.floor(endPage)));
  const pageTexts: string[] = [];

  for (let pageNumber = safeStart; pageNumber <= safeEnd; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const rows = new Map<number, Array<{ x: number; text: string }>>();

    for (const item of textContent.items) {
      if (!('str' in item) || !('transform' in item)) continue;
      const text = normalizeFragment(item.str || '');
      if (!text) continue;

      const x = Array.isArray(item.transform) ? Number(item.transform[4] || 0) : 0;
      const yRaw = Array.isArray(item.transform) ? Number(item.transform[5] || 0) : 0;
      const y = Math.round(yRaw * 10) / 10;
      const bucket = rows.get(y) || [];
      bucket.push({ x, text });
      rows.set(y, bucket);
    }

    const orderedRows = [...rows.entries()]
      .sort((left, right) => right[0] - left[0])
      .map((entry) => entry[1].sort((left, right) => left.x - right.x).map((part) => part.text).join(' '))
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    pageTexts.push(orderedRows.join('\n'));
  }

  return pageTexts.join('\n\n').trim();
}
