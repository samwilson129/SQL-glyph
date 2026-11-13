export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

export interface PositionProvider {
  positionAt(offset: number): PositionLike;
}

export interface SpanLike {
  readonly start: number;
  readonly end: number;
}

export function clampOffset(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

/**
 * Maps an engine span (UTF-16 offsets relative to the SQL input) into a range
 * in the source document. `baseOffset` is the document offset where the SQL
 * input begins (non-zero for selections).
 */
export function rangeFromSpan(
  document: PositionProvider,
  textLength: number,
  span: SpanLike,
  baseOffset = 0
): RangeLike {
  const start = clampOffset(baseOffset + span.start, 0, textLength);
  const end = clampOffset(baseOffset + span.end, start, textLength);
  return {
    start: document.positionAt(start),
    end: document.positionAt(end)
  };
}

/**
 * Pure offset-to-position helper used by tests and by code that only has the
 * raw text. VS Code documents use `positionAt` directly so line endings and
 * UTF-16 surrogate pairs match the editor exactly.
 */
export function offsetToPosition(text: string, offset: number): PositionLike {
  const clamped = clampOffset(offset, 0, text.length);
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: clamped - lineStart };
}

export function spanLength(span: SpanLike | null | undefined): number {
  if (!span) {
    return 0;
  }
  return Math.max(0, span.end - span.start);
}
