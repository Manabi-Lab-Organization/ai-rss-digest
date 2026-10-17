import { inflateRawSync } from 'node:zlib';

export const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024;

export const MAX_DOCUMENT_TEXT_CHARS = 100_000;

export function decodeTextFile(buf: Buffer): string {
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

export function readZipEntry(zip: Buffer, entryName: string): Buffer | null {
  const minEocd = 22;
  let eocd = -1;
  for (let i = zip.length - minEocd; i >= Math.max(0, zip.length - minEocd - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const uncompressedSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      if (uncompressedSize > MAX_UNZIPPED_BYTES) return null;
      if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function codePointToChar(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(cp);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => codePointToChar(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointToChar(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function extractDocxText(buf: Buffer): string | null {
  let xml: string;
  try {
    const entry = readZipEntry(buf, 'word/document.xml');
    if (!entry) return null;
    xml = entry.toString('utf8');
  } catch {
    return null;
  }
  const paragraphs: string[] = [];
  for (const [, body] of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    let line = '';
    for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\/>/g)) {
      if (m[1] !== undefined) line += m[1];
      else line += m[0] === '<w:tab/>' ? '\t' : '\n';
    }
    paragraphs.push(line);
  }
  const text = paragraphs.join('\n');
  return decodeXmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
}

export function clampDocumentText(text: string): string {
  if (text.length <= MAX_DOCUMENT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\n\n（長いため、ここから先 ${text.length - MAX_DOCUMENT_TEXT_CHARS} 字は省略しました）`;
}
