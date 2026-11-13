import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandHome,
  findPython,
  managedVenvPython,
  parsePythonVersion,
  pythonCandidates,
  type ExecFn
} from '../../src/engine/pythonDiscovery';

interface FakeResponse {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

function fakeExec(responses: Record<string, FakeResponse>): ExecFn {
  return async (command) => {
    const response = responses[command];
    if (!response) {
      return { code: 127, stdout: '', stderr: `${command}: not found` };
    }
    return {
      code: response.code ?? 0,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? ''
    };
  };
}

describe('python discovery', () => {
  it('parses Python version strings', () => {
    expect(parsePythonVersion('Python 3.12.6')).toEqual({
      major: 3,
      minor: 12,
      patch: 6,
      raw: '3.12.6'
    });
    expect(parsePythonVersion('3.9.0\n')).toEqual({
      major: 3,
      minor: 9,
      patch: 0,
      raw: '3.9.0'
    });
    expect(parsePythonVersion('not a version')).toBeUndefined();
  });

  it('builds the managed virtualenv interpreter path', () => {
    expect(managedVenvPython('/storage/engine-venv', 'win32')).toBe(
      path.join('/storage/engine-venv', 'Scripts', 'python.exe')
    );
    expect(managedVenvPython('/storage/engine-venv', 'linux')).toBe(
      path.join('/storage/engine-venv', 'bin', 'python')
    );
  });

  it('prefers a configured interpreter when it is compatible', async () => {
    const result = await findPython({
      configuredPath: '"/custom/python"',
      managedPythonPath: '/managed/python',
      platform: 'linux',
      exec: fakeExec({
        '/custom/python': { stdout: '3.12.6' },
        '/managed/python': { stdout: '3.11.9' },
        python3: { stdout: '3.10.1' }
      })
    });

    expect(result.resolution?.source).toBe('setting');
    expect(result.resolution?.command).toBe('/custom/python');
    expect(result.resolution?.version).toBe('3.12.6');
  });

  it('falls back to the managed environment when the configured interpreter fails', async () => {
    const result = await findPython({
      configuredPath: '/broken/python',
      managedPythonPath: '/managed/python',
      platform: 'linux',
      exec: fakeExec({
        '/broken/python': { code: 1, stderr: 'not executable' },
        '/managed/python': { stdout: '3.12.6' },
        python3: { stdout: '3.12.6' }
      })
    });

    expect(result.resolution?.source).toBe('managed');
    expect(result.resolution?.command).toBe('/managed/python');
  });

  it('falls back to PATH candidates', async () => {
    const result = await findPython({
      platform: 'linux',
      exec: fakeExec({
        python3: { stdout: '3.12.6' },
        python: { stdout: '3.12.6' }
      })
    });

    expect(result.resolution?.source).toBe('path');
    expect(result.resolution?.command).toBe('python3');
  });

  it('rejects interpreters older than Python 3.9', async () => {
    const result = await findPython({
      platform: 'linux',
      exec: fakeExec({
        python3: { stdout: '3.8.10' },
        python: { stdout: '3.12.6' }
      })
    });

    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].error).toContain('older than');
    expect(result.resolution?.command).toBe('python');
  });

  it('supports the Windows py launcher', async () => {
    const result = await findPython({
      platform: 'win32',
      exec: fakeExec({
        py: { stdout: '3.12.6' }
      })
    });

    expect(result.resolution?.command).toBe('py');
    expect(result.resolution?.args).toEqual(['-3']);
  });

  it('returns no resolution when nothing works', async () => {
    const result = await findPython({
      platform: 'linux',
      exec: fakeExec({})
    });

    expect(result.resolution).toBeUndefined();
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts.every((attempt) => !attempt.ok)).toBe(true);
  });

  it('deduplicates candidates and expands home directories', () => {
    const candidates = pythonCandidates({
      configuredPath: '~',
      managedPythonPath: '~',
      platform: 'linux'
    });
    const keys = candidates.map((candidate) => `${candidate.command}:${candidate.args.join(',')}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(expandHome('~/python')).toContain('python');
  });
});
