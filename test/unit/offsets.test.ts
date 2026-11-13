import { describe, expect, it } from 'vitest';
import {
  clampOffset,
  offsetToPosition,
  rangeFromSpan,
  spanLength
} from '../../src/util/offsets';

const text = 'abc\ndef\nghi';
const document = {
  positionAt: (offset: number) => offsetToPosition(text, offset)
};

describe('offset helpers', () => {
  it('clamps offsets into the document bounds', () => {
    expect(clampOffset(5, 0, 3)).toBe(3);
    expect(clampOffset(-2, 0, 3)).toBe(0);
    expect(clampOffset(Number.NaN, 0, 3)).toBe(0);
    expect(clampOffset(Number.POSITIVE_INFINITY, 0, 3)).toBe(0);
    expect(clampOffset(2.9, 0, 3)).toBe(2);
    expect(clampOffset(2, 0, 3)).toBe(2);
  });

  it('converts UTF-16 offsets to line and character positions', () => {
    expect(offsetToPosition(text, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(text, 2)).toEqual({ line: 0, character: 2 });
    expect(offsetToPosition(text, 4)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(text, 7)).toEqual({ line: 1, character: 3 });
    expect(offsetToPosition(text, 99)).toEqual({ line: 2, character: 3 });
  });

  it('maps engine spans into document ranges', () => {
    const range = rangeFromSpan(document, text.length, { start: 4, end: 7 });
    expect(range.start).toEqual({ line: 1, character: 0 });
    expect(range.end).toEqual({ line: 1, character: 3 });
  });

  it('applies the base offset used for selections', () => {
    const shifted = rangeFromSpan(document, text.length, { start: 0, end: 3 }, 4);
    expect(shifted.start).toEqual({ line: 1, character: 0 });
    expect(shifted.end).toEqual({ line: 1, character: 3 });
  });

  it('never lets the end precede the start', () => {
    const range = rangeFromSpan(document, text.length, { start: 8, end: 2 });
    expect(range.start).toEqual({ line: 2, character: 0 });
    expect(range.end).toEqual({ line: 2, character: 0 });
  });

  it('clamps spans that extend past the document', () => {
    const range = rangeFromSpan(document, text.length, { start: 9, end: 500 }, 0);
    expect(range.start).toEqual({ line: 2, character: 1 });
    expect(range.end).toEqual({ line: 2, character: 3 });
  });

  it('reports span length safely', () => {
    expect(spanLength({ start: 2, end: 7 })).toBe(5);
    expect(spanLength({ start: 7, end: 2 })).toBe(0);
    expect(spanLength(null)).toBe(0);
    expect(spanLength(undefined)).toBe(0);
  });
});
