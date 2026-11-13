import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineAction, EngineHealth, EngineResponse, HealthPayload } from '../types/protocol';
import { EngineUnavailableError } from './errors';
import { PythonBridge } from './pythonBridge';
import { PythonEnvironment } from './pythonEnvironment';
import type { PythonResolution } from './pythonDiscovery';

export type EngineStatus =
  | 'unknown'
  | 'unconfigured'
  | 'starting'
  | 'ready'
  | 'missing-dependency'
  | 'error'
  | 'stopped';

export interface EngineSnapshot {
  readonly ready: boolean;
  readonly status: EngineStatus;
  readonly message: string;
  readonly pythonVersion?: string;
  readonly pythonDisplay?: string;
  readonly sqlglotVersion?: string;
}

const INITIAL_SNAPSHOT: EngineSnapshot = {
  ready: false,
  status: 'unknown',
  message: 'The local engine has not been started yet.'
};

export class EngineManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<EngineSnapshot>();
  readonly onDidChangeState = this.emitter.event;

  private bridge?: PythonBridge;
  private snapshot: EngineSnapshot = INITIAL_SNAPSHOT;
  private health?: EngineHealth;
  private resolution?: PythonResolution;
  private ready = false;
  private readyCheck?: Promise<boolean>;
  private generation = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly environment: PythonEnvironment
  ) {}

  get engineScript(): string {
    return vscode.Uri.joinPath(this.context.extensionUri, 'sql-engine', 'main.py').fsPath;
  }

  getSnapshot(): EngineSnapshot {
    return this.snapshot;
  }

  getHealth(): EngineHealth | undefined {
    return this.health;
  }

  getResolution(): PythonResolution | undefined {
    return this.resolution;
  }

  async resolve(force = false): Promise<PythonResolution | null> {
    return this.environment.resolve(force);
  }

  async request<T>(
    action: EngineAction,
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<EngineResponse<T>> {
    const bridge = await this.getBridge();
    return bridge.request<T>(action, payload, timeoutMs);
  }

  async ensureReady(interactive: boolean): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    if (this.readyCheck) {
      return this.readyCheck;
    }
    const check = this.checkReady(interactive).finally(() => {
      if (this.readyCheck === check) {
        this.readyCheck = undefined;
      }
    });
    this.readyCheck = check;
    return check;
  }

  reset(): void {
    this.generation += 1;
    this.resetBridge();
    this.environment.reset();
    this.ready = false;
    this.health = undefined;
    this.resolution = undefined;
    this.update({
      ready: false,
      status: 'unknown',
      message: 'The local engine configuration changed. It will restart on the next request.'
    });
  }

  dispose(): void {
    this.generation += 1;
    this.resetBridge();
    this.emitter.dispose();
  }

  private async checkReady(interactive: boolean): Promise<boolean> {
    const generation = this.generation;

    try {
      const resolution = await this.environment.resolve();
      if (generation !== this.generation) {
        return false;
      }

      if (!resolution) {
        this.update({
          ready: false,
          status: 'unconfigured',
          message: 'No Python 3.9+ interpreter was found. Set up the local engine to continue.'
        });
        return this.offerSetup(
          interactive,
          'SQL Glyph could not find a Python 3.9+ interpreter. The local engine needs Python and SQLGlot to parse and transpile SQL.',
          generation
        );
      }

      this.update({
        ready: false,
        status: 'starting',
        message: `Checking ${resolution.display} (Python ${resolution.version})…`,
        pythonDisplay: resolution.display,
        pythonVersion: resolution.version
      });

      const bridge = await this.getBridge();
      const response = await bridge.request<HealthPayload>('health', {}, 20000);
      if (generation !== this.generation) {
        return false;
      }

      if (response.success && response.health.ok) {
        this.ready = true;
        this.health = response.health;
        this.resolution = resolution;
        this.update({
          ready: true,
          status: 'ready',
          message: `SQLGlot ${response.health.sqlglotVersion} · Python ${response.health.pythonVersion}`,
          pythonVersion: response.health.pythonVersion,
          pythonDisplay: resolution.display,
          sqlglotVersion: response.health.sqlglotVersion
        });
        this.output.appendLine(
          `[health] SQLGlot ${response.health.sqlglotVersion} on Python ${response.health.pythonVersion}; ${response.health.dialectCount} dialects.`
        );
        return true;
      }

      const error = response.success ? undefined : response.error;
      const detail = error
        ? `${error.code}: ${error.message}`
        : 'The health check returned an unexpected response.';
      this.output.appendLine(`[health] ${detail}`);

      if (error?.code === 'DEPENDENCY_MISSING') {
        this.update({
          ready: false,
          status: 'missing-dependency',
          message: `SQLGlot is not installed for ${resolution.display}. Set up the local engine to install it.`,
          pythonDisplay: resolution.display,
          pythonVersion: resolution.version
        });
        return this.offerSetup(
          interactive,
          `SQLGlot is not installed for ${resolution.display}. SQL Glyph does not install dependencies silently.`,
          generation
        );
      }

      this.update({
        ready: false,
        status: 'error',
        message: error?.message ?? 'The local engine health check failed.',
        pythonDisplay: resolution.display,
        pythonVersion: resolution.version
      });
      return this.offerSetup(
        interactive,
        `The local engine could not start: ${error?.message ?? 'unknown error'}`,
        generation
      );
    } catch (caught) {
      if (generation !== this.generation) {
        return false;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      this.output.appendLine(`[engine] ${message}`);
      this.update({
        ready: false,
        status: 'error',
        message
      });
      return this.offerSetup(interactive, `The local engine could not start: ${message}`, generation);
    }
  }

  private async offerSetup(
    interactive: boolean,
    reason: string,
    generation: number
  ): Promise<boolean> {
    if (!interactive || generation !== this.generation) {
      return false;
    }
    const didSetup = await this.environment.promptForSetup(reason);
    if (!didSetup) {
      return false;
    }
    this.environment.reset();
    this.resetBridge();
    this.generation += 1;
    return this.checkReady(false);
  }

  private async getBridge(): Promise<PythonBridge> {
    if (this.bridge?.isRunning) {
      return this.bridge;
    }

    const resolution = await this.environment.resolve();
    if (!resolution) {
      throw new EngineUnavailableError(
        'PYTHON_NOT_FOUND',
        'No Python 3.9+ interpreter was found.',
        'Run "SQL Glyph: Set Up Local Engine" or set sqlGlyph.pythonPath.'
      );
    }

    const timeoutMs = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<number>('engineTimeoutMs', 30000);

    const bridge = new PythonBridge({
      pythonPath: resolution.command,
      pythonArgs: resolution.args,
      engineScript: this.engineScript,
      cwd: path.dirname(this.engineScript),
      timeoutMs,
      logger: (line) => this.output.appendLine(`[engine] ${line}`),
      onStderr: (line) => this.output.appendLine(`[engine:stderr] ${line}`),
      onExit: (code, signal) => {
        if (this.bridge !== bridge) {
          return;
        }
        this.ready = false;
        this.update({
          ready: false,
          status: 'stopped',
          message: 'The local engine stopped. It restarts automatically on the next request.'
        });
        this.output.appendLine(
          `[engine] exited (code=${String(code)}, signal=${String(signal)}).`
        );
      }
    });

    try {
      await bridge.start();
    } catch (error) {
      bridge.dispose();
      throw new EngineUnavailableError(
        'ENGINE_START_FAILED',
        error instanceof Error ? error.message : String(error),
        'Run "SQL Glyph: Set Up Local Engine" or set sqlGlyph.pythonPath.'
      );
    }

    this.bridge = bridge;
    this.resolution = resolution;
    this.update({
      ready: false,
      status: 'starting',
      message: `Started ${resolution.display} (Python ${resolution.version}).`,
      pythonDisplay: resolution.display,
      pythonVersion: resolution.version
    });
    return bridge;
  }

  private resetBridge(): void {
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) {
      bridge.dispose();
    }
  }

  private update(patch: EngineSnapshot): void {
    this.snapshot = patch;
    this.emitter.fire(patch);
  }
}
