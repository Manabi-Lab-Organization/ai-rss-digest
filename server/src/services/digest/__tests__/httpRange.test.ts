import { describe, it, expect } from 'vitest';
import { parseRange, byteaSliceParams } from '../httpRange.js';

describe('parseRange', () => {
  it('Range ヘッダが無いとき、またはサイズが0のときは null', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('bytes=0-499', 0)).toBeNull();
  });

  it('開始と終了を指定した範囲を読み取る', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
    expect(parseRange('bytes=500-999', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('終了が無ければ最後まで、サイズを超える終了は最後に合わせる', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=0-9999', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('末尾からのバイト数の指定を読み取る', () => {
    expect(parseRange('bytes=-300', 1000)).toEqual({ start: 700, end: 999 });
    expect(parseRange('bytes=-2000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('応じられない範囲は unsatisfiable を返す', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ unsatisfiable: true });
    expect(parseRange('bytes=800-700', 1000)).toEqual({ unsatisfiable: true });
    expect(parseRange('bytes=-0', 1000)).toEqual({ unsatisfiable: true });
  });

  it('読めない形・複数範囲・bytes 以外の単位は null', () => {
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=abc-def', 1000)).toBeNull();
    expect(parseRange('bytes=0-100,200-300', 1000)).toBeNull();
    expect(parseRange('items=0-100', 1000)).toBeNull();
  });
});

describe('byteaSliceParams', () => {
  it('範囲が無ければ全体を指し、from は1から数える', () => {
    expect(byteaSliceParams(null, 1000)).toEqual({ from: 1, length: 1000, start: 0, end: 999 });
  });

  it('最初の1バイトだけを指す', () => {
    const r = parseRange('bytes=0-0', 1000) as { start: number; end: number };
    expect(byteaSliceParams(r, 1000)).toEqual({ from: 1, length: 1, start: 0, end: 0 });
  });

  it('途中から始まる範囲では from が start + 1 になる', () => {
    const r = parseRange('bytes=10-19', 1000) as { start: number; end: number };
    expect(byteaSliceParams(r, 1000)).toEqual({ from: 11, length: 10, start: 10, end: 19 });
  });

  it('終了が無い範囲では最後までを指す', () => {
    const r = parseRange('bytes=500-', 1000) as { start: number; end: number };
    expect(byteaSliceParams(r, 1000)).toEqual({ from: 501, length: 500, start: 500, end: 999 });
  });

  it('末尾からのバイト数の指定を位置に直す', () => {
    const r = parseRange('bytes=-10', 1000) as { start: number; end: number };
    expect(byteaSliceParams(r, 1000)).toEqual({ from: 991, length: 10, start: 990, end: 999 });
  });

  it('隣り合う2つの範囲は重ならず、合わせると全体の長さになる', () => {
    const size = 1000;
    const a = byteaSliceParams(parseRange('bytes=0-499', size) as any, size);
    const b = byteaSliceParams(parseRange('bytes=500-', size) as any, size);
    expect(a.length + b.length).toBe(size);
    expect(b.from).toBe(a.from + a.length);
  });
});
