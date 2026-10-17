
export type ByteRange = { start: number; end: number } | { unsatisfiable: true };

export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

export function byteaSliceParams(
  range: { start: number; end: number } | null,
  size: number
): { from: number; length: number; start: number; end: number } {
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  return { from: start + 1, length: end - start + 1, start, end };
}
