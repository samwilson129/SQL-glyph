import { describe, expect, it } from 'vitest';
import {
  conversionStatusLabel,
  countDiagnostics,
  countTransformations
} from '../../src/types/conversion';
import type { EngineDiagnostic, Transformation } from '../../src/types/diagnostics';

function diagnostic(severity: EngineDiagnostic['severity']): EngineDiagnostic {
  return {
    id: `${severity}-1`,
    severity,
    category: 'test',
    message: severity
  };
}

function transformation(explanation: string | null): Transformation {
  return {
    id: `t-${explanation ?? 'none'}`,
    category: 'test',
    nodeType: 'Select',
    original: 'a',
    converted: 'b',
    explanation,
    detail: null,
    confidence: explanation ? 'high' : 'unexplained',
    review: explanation ? 'review' : 'unexplained',
    ruleId: explanation ? 'rule' : null,
    statementIndex: 0
  };
}

describe('conversion helpers', () => {
  it('counts diagnostics by severity', () => {
    expect(countDiagnostics([])).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(
      countDiagnostics([
        diagnostic('error'),
        diagnostic('error'),
        diagnostic('warning'),
        diagnostic('info'),
        diagnostic('info')
      ])
    ).toEqual({ errors: 2, warnings: 1, info: 2 });
  });

  it('counts explained and unexplained transformations', () => {
    expect(countTransformations([])).toEqual({ explained: 0, unexplained: 0 });
    expect(
      countTransformations([
        transformation('because'),
        transformation(null),
        transformation('also because'),
        transformation(null)
      ])
    ).toEqual({ explained: 2, unexplained: 2 });
  });

  it('labels every conversion status', () => {
    expect(conversionStatusLabel('success')).toBe('Success');
    expect(conversionStatusLabel('warning')).toBe('Warning');
    expect(conversionStatusLabel('unsupported')).toBe('Unsupported');
  });
});
