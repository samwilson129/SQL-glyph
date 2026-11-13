import { spawn } from 'node:child_process';

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Runs a process without a shell and captures its output. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs)
        : undefined;

    const append = (current: string, chunk: string): string => {
      if (current.length >= maxOutput) {
        return current;
      }
      const next = current + chunk;
      return next.length > maxOutput ? next.slice(0, maxOutput) : next;
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code,
        signal,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        timedOut
      });
    });
  });
}
