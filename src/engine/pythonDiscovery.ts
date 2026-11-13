import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from './processRunner';

export type PythonSource = 'setting' | 'managed' | 'path';

export interface PythonCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: PythonSource;
  readonly display: string;
}

export interface PythonAttempt extends PythonCommand {
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

export interface PythonResolution {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: PythonSource;
  readonly display: string;
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number }
) => Promise<ExecResult>;

export interface FindPythonOptions {
  readonly configuredPath?: string;
  readonly managedPythonPath?: string;
  readonly exec?: ExecFn;
  readonly platform?: NodeJS.Platform;
  readonly minMajor?: number;
  readonly minMinor?: number;
  readonly includeManaged?: boolean;
}

export interface FindPythonResult {
  readonly resolution?: PythonResolution;
  readonly attempts: readonly PythonAttempt[];
}

const PROBE_SCRIPT = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

export const defaultExec: ExecFn = async (command, args, options) => {
  try {
    const result = await runCommand(command, args, {
      timeoutMs: options?.timeoutMs ?? 15000
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
};

export function managedVenvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function displayFor(command: string, args: readonly string[]): string {
  return args.length > 0 ? `${command} ${args.join(' ')}` : command;
}

export function pythonCandidates(options: FindPythonOptions = {}): PythonCommand[] {
  const platform = options.platform ?? process.platform;
  const candidates: PythonCommand[] = [];

  const configured = options.configuredPath ? expandHome(stripQuotes(options.configuredPath)) : '';
  if (configured) {
    candidates.push({
      command: configured,
      args: [],
      source: 'setting',
      display: configured
    });
  }

  if (options.includeManaged !== false && options.managedPythonPath) {
    candidates.push({
      command: options.managedPythonPath,
      args: [],
      source: 'managed',
      display: options.managedPythonPath
    });
  }

  const pathCommands: Array<{ command: string; args: string[] }> =
    platform === 'win32'
      ? [
          { command: 'python', args: [] },
          { command: 'python3', args: [] },
          { command: 'py', args: ['-3'] }
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] }
        ];

  for (const item of pathCommands) {
    candidates.push({
      command: item.command,
      args: item.args,
      source: 'path',
      display: displayFor(item.command, item.args)
    });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\u0000${candidate.args.join('\u0000')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export interface ParsedPythonVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export function parsePythonVersion(output: string): ParsedPythonVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return undefined;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    raw: match[0]
  };
}

export async function probePython(
  exec: ExecFn,
  candidate: PythonCommand,
  minMajor = 3,
  minMinor = 9
): Promise<PythonAttempt> {
  let result: ExecResult;
  try {
    result = await exec(candidate.command, [...candidate.args, '-c', PROBE_SCRIPT], {
      timeoutMs: 15000
    });
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    return {
      ...candidate,
      ok: false,
      error: detail.length > 0 ? detail.slice(0, 500) : `Exited with code ${String(result.code)}`
    };
  }

  const parsed = parsePythonVersion(`${result.stdout}\n${result.stderr}`);
  if (!parsed) {
    return {
      ...candidate,
      ok: false,
      error: 'The interpreter did not report a Python version.'
    };
  }

  const compatible =
    parsed.major > minMajor || (parsed.major === minMajor && parsed.minor >= minMinor);
  return {
    ...candidate,
    ok: compatible,
    version: parsed.raw,
    error: compatible
      ? undefined
      : `Python ${parsed.raw} is older than the required Python ${minMajor}.${minMinor}.`
  };
}

function toResolution(attempt: PythonAttempt, parsed: ParsedPythonVersion): PythonResolution {
  return {
    command: attempt.command,
    args: attempt.args,
    source: attempt.source,
    display: attempt.display,
    version: parsed.raw,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch
  };
}

export async function findPython(options: FindPythonOptions = {}): Promise<FindPythonResult> {
  const exec = options.exec ?? defaultExec;
  const minMajor = options.minMajor ?? 3;
  const minMinor = options.minMinor ?? 9;
  const attempts: PythonAttempt[] = [];

  for (const candidate of pythonCandidates(options)) {
    const attempt = await probePython(exec, candidate, minMajor, minMinor);
    attempts.push(attempt);
    if (attempt.ok && attempt.version) {
      const parsed = parsePythonVersion(attempt.version);
      if (parsed) {
        return {
          resolution: toResolution(attempt, parsed),
          attempts
        };
      }
    }
  }

  return { attempts };
}

export function describeResolution(resolution: PythonResolution): string {
  return `Python ${resolution.version} (${resolution.display})`;
}
