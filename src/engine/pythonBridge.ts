import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process';
import type { EngineAction, EngineRequest, EngineResponse } from '../types/protocol';
import { JsonLineDecoder } from './jsonLines';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export type BridgeErrorCode =
  | 'ENGINE_START_FAILED'
  | 'ENGINE_STOPPED'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'DISPOSED'
  | 'ABORTED';

export interface BridgeRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class BridgeError extends Error {
  public readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface PythonBridgeOptions {
  readonly pythonPath: string;
  readonly pythonArgs?: readonly string[];
  readonly engineScript: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly logger?: (message: string) => void;
  readonly onStderr?: (line: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly spawnFn?: SpawnFn;
}

interface QueuedRequest {
  readonly id: string;
  readonly action: EngineAction;
  readonly payload: Record<string, unknown>;
  readonly resolve: (response: EngineResponse<unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly enqueuedAt: number;
  readonly signal?: AbortSignal;
  cleanup?: () => void;
}

const DEFAULT_TIMEOUT_MS = 30000;

export class PythonBridge {
  private readonly pythonPath: string;
  private readonly pythonArgs: readonly string[];
  private readonly engineScript: string;
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly logger?: (message: string) => void;
  private readonly onStderr?: (line: string) => void;
  private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly spawnFn: SpawnFn;

  private child?: ChildProcessWithoutNullStreams;
  private stdoutDecoder = new JsonLineDecoder();
  private stderrDecoder = new JsonLineDecoder();
  private active?: QueuedRequest;
  private queue: QueuedRequest[] = [];
  private nextId = 1;
  private startPromise?: Promise<void>;
  private disposed = false;
  private stopping = false;

  constructor(options: PythonBridgeOptions) {
    this.pythonPath = options.pythonPath;
    this.pythonArgs = options.pythonArgs ?? [];
    this.engineScript = options.engineScript;
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
    this.onStderr = options.onStderr;
    this.onExit = options.onExit;
    this.spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
  }

  get isRunning(): boolean {
    return this.child !== undefined;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new BridgeError('DISPOSED', 'The local engine client has been disposed.');
    }
    if (this.child) {
      return;
    }
    this.stopping = false;
    this.stdoutDecoder = new JsonLineDecoder();
    this.stderrDecoder = new JsonLineDecoder();

    const args = [...this.pythonArgs, this.engineScript];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.pythonPath, args, {
        cwd: this.cwd,
        env: this.buildEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      throw new BridgeError(
        'ENGINE_START_FAILED',
        `Could not start the Python engine: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));

    child.on('error', (error) => {
      this.handleExit(null, null, error);
    });
    child.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      };
      const onSpawn = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new BridgeError(
            'ENGINE_START_FAILED',
            `Could not start the Python engine: ${error.message}`
          )
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    this.logger?.(`Local engine started: ${this.pythonPath} ${args.slice(0, -1).join(' ')}`.trim());
    this.pump();
  }

  request<T>(
    action: EngineAction,
    payload: Record<string, unknown> = {},
    options: number | BridgeRequestOptions = {}
  ): Promise<EngineResponse<T>> {
    if (this.disposed) {
      return Promise.reject(
        new BridgeError('DISPOSED', 'The local engine client has been disposed.')
      );
    }

    const timeoutMs = typeof options === 'number' ? options : options.timeoutMs ?? this.timeoutMs;
    const signal = typeof options === 'number' ? undefined : options.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new BridgeError('ABORTED', 'The local engine request was cancelled.')
      );
    }

    return new Promise<EngineResponse<T>>((resolve, reject) => {
      const id = String(this.nextId);
      this.nextId += 1;
      const timer = setTimeout(() => this.handleTimeout(id), Math.max(1, timeoutMs));
      timer.unref?.();

      const onAbort = (): void => this.handleAbort(id);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push({
        id,
        action,
        payload,
        resolve: resolve as (response: EngineResponse<unknown>) => void,
        reject,
        timer,
        enqueuedAt: Date.now(),
        signal,
        cleanup: signal ? () => signal.removeEventListener('abort', onAbort) : undefined
      });

      void this.ensureStarted()
        .then(() => this.pump())
        .catch((error: unknown) => {
          this.removeQueued(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.failAll(new BridgeError('ENGINE_STOPPED', 'The local engine is not running.'));
      return;
    }

    const request: EngineRequest = {
      id: `shutdown-${Date.now()}`,
      action: 'shutdown'
    };
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end();
    } catch {
      // The process may already be gone; the exit handler cleans up.
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Ignore.
        }
        finish();
      }, 1500);
      timer.unref?.();
      child.once('exit', finish);
    });

    if (this.child === child) {
      this.child = undefined;
    }
    this.failAll(new BridgeError('ENGINE_STOPPED', 'The local engine was stopped.'));
  }

  dispose(): void {
    this.disposed = true;
    void this.stop();
  }

  private ensureStarted(): Promise<void> {
    if (this.child) {
      return Promise.resolve();
    }
    if (this.disposed) {
      return Promise.reject(
        new BridgeError('DISPOSED', 'The local engine client has been disposed.')
      );
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private buildEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.env
    };
    delete environment.PYTHONPATH;
    delete environment.PYTHONHOME;
    delete environment.PYTHONSTARTUP;
    environment.PYTHONIOENCODING = 'utf-8';
    environment.PYTHONUNBUFFERED = '1';
    environment.PYTHONDONTWRITEBYTECODE = '1';
    return environment;
  }

  private handleStdout(chunk: string): void {
    for (const line of this.stdoutDecoder.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.logger?.(`Unparseable engine output: ${line.slice(0, 300)}`);
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        this.logger?.(`Unexpected engine output: ${line.slice(0, 300)}`);
        continue;
      }

      const response = parsed as EngineResponse<unknown> & { id?: unknown };
      const id = response.id === null || response.id === undefined ? undefined : String(response.id);

      if (this.active && id === this.active.id) {
        const request = this.active;
        this.active = undefined;
        this.finish(request);
        request.resolve(response);
        this.pump();
        continue;
      }

      if (id) {
        const index = this.queue.findIndex((item) => item.id === id);
        if (index >= 0) {
          const [request] = this.queue.splice(index, 1);
          this.finish(request);
          request.resolve(response);
          continue;
        }
      }

      this.logger?.(`Unexpected engine response: ${line.slice(0, 300)}`);
    }
  }

  private handleStderr(chunk: string): void {
    for (const line of this.stderrDecoder.push(chunk)) {
      this.logger?.(line);
      this.onStderr?.(line);
    }
  }

  private pump(): void {
    if (this.active || !this.child || this.disposed) {
      return;
    }
    const request = this.queue.shift();
    if (!request) {
      return;
    }
    this.active = request;
    const line = `${JSON.stringify({
      id: request.id,
      action: request.action,
      payload: request.payload
    })}\n`;

    try {
      this.child.stdin.write(line, 'utf8', (error) => {
        if (error && this.active?.id === request.id) {
          this.failActive(
            new BridgeError('ENGINE_STOPPED', `Could not write to the local engine: ${error.message}`)
          );
          this.terminate();
        }
      });
    } catch (error) {
      this.failActive(
        new BridgeError(
          'ENGINE_STOPPED',
          `Could not write to the local engine: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      this.terminate();
    }
  }

  private handleAbort(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1);
      this.finish(request);
      request.reject(
        new BridgeError('ABORTED', 'The local engine request was cancelled.')
      );
      return;
    }

    if (this.active?.id === id) {
      const request = this.active;
      this.active = undefined;
      this.finish(request);
      request.reject(
        new BridgeError(
          'ABORTED',
          'The local engine request was cancelled. The engine process was restarted.'
        )
      );
      this.logger?.('Engine request cancelled; terminating the engine process.');
      this.terminate();
    }
  }

  private finish(request: QueuedRequest): void {
    clearTimeout(request.timer);
    request.cleanup?.();
    request.cleanup = undefined;
  }

  private handleTimeout(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1);
      this.finish(request);
      request.reject(
        new BridgeError(
          'TIMEOUT',
          `The local engine did not respond within ${this.timeoutMs} ms.`
        )
      );
      return;
    }

    if (this.active?.id === id) {
      const request = this.active;
      this.active = undefined;
      this.finish(request);
      request.reject(
        new BridgeError(
          'TIMEOUT',
          `The local engine did not respond within ${this.timeoutMs} ms. The engine process was restarted.`
        )
      );
      this.logger?.('Engine request timed out; terminating the engine process.');
      this.terminate();
    }
  }

  private removeQueued(id: string): void {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1);
      this.finish(request);
    }
  }

  private failActive(error: Error): void {
    if (!this.active) {
      return;
    }
    const request = this.active;
    this.active = undefined;
    this.finish(request);
    request.reject(error);
  }

  private failAll(error: Error): void {
    this.failActive(error);
    const queued = this.queue.splice(0);
    for (const request of queued) {
      this.finish(request);
      request.reject(error);
    }
  }

  private terminate(): void {
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }
    this.failAll(new BridgeError('ENGINE_STOPPED', 'The local engine process was stopped.'));
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error
  ): void {
    const wasRunning = this.child !== undefined;
    this.child = undefined;
    this.failAll(
      new BridgeError(
        'ENGINE_STOPPED',
        error
          ? `The local engine process failed: ${error.message}`
          : `The local engine process exited${code !== null ? ` with code ${code}` : ''}${
              signal ? ` (${signal})` : ''
            }.`
      )
    );

    if (wasRunning) {
      this.logger?.(
        error
          ? `Engine process error: ${error.message}`
          : `Engine process exited (code=${String(code)}, signal=${String(signal)}).`
      );
    }

    if (!this.stopping) {
      this.onExit?.(code, signal);
    }
  }
}
