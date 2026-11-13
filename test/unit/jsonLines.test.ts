import { describe, expect, it } from 'vitest';
import { JsonLineDecoder } from '../../src/engine/jsonLines';

describe('JsonLineDecoder', () => {
  it('decodes complete lines and retains partial data', () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(decoder.pending).toBe('{"b":');
    expect(decoder.push('2}\n')).toEqual(['{"b":2}']);
    expect(decoder.pending).toBe('');
  });

  it('handles CRLF and blank lines', () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"a":1}\r\n\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles multiple chunks split inside a line', () => {
    const decoder = new JsonLineDecoder();
    const lines: string[] = [];
    for (const chunk of ['{"mess', 'age":"hel', 'lo"}\n{"x":', '2}\n']) {
      lines.push(...decoder.push(chunk));
    }
    expect(lines).toEqual(['{"message":"hello"}', '{"x":2}']);
  });

  it('flushes a trailing line', () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"tail":true}')).toEqual([]);
    expect(decoder.flush()).toEqual(['{"tail":true}']);
    expect(decoder.flush()).toEqual([]);
  });
});
