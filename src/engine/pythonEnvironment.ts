import * as vscode from 'vscode';
import {
  defaultExec,
  describeResolution,
  findPython,
  managedVenvPython,
  parsePythonVersion,
  probePython,
  pythonCandidates,
  type PythonAttempt,
  type PythonCommand,
  type PythonResolution
} from './pythonDiscovery';
import { runCommand } from './processRunner';

const SQLGLOT_VERSION = '30.31.0';

interface PythonPickItem extends vscode.QuickPickItem {
  readonly candidate?: PythonCommand;
  readonly browse?: boolean;
}

export class PythonEnvironment {
  private cached: PythonResolution | null | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  get managedVenvDir(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'engine-venv').fsPath;
  }

  get managedPython(): string {
    return managedVenvPython(this.managedVenvDir, process.platform);
  }

  reset(): void {
    this.cached = undefined;
  }

  async resolve(force = false): Promise<PythonResolution | null> {
    if (this.cached !== undefined && !force) {
      return this.cached;
    }

    const configured = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<string>('pythonPath', '')
      .trim();

    const result = await findPython({
      configuredPath: configured.length > 0 ? configured : undefined,
      managedPythonPath: this.managedPython,
      exec: defaultExec,
      platform: process.platform
    });

    for (const attempt of result.attempts) {
      if (attempt.ok) {
        this.output.appendLine(
          `[python] ${describeResolution({
            command: attempt.command,
            args: attempt.args,
            source: attempt.source,
            display: attempt.display,
            version: attempt.version ?? '',
            major: 0,
            minor: 0,
            patch: 0
          })} via ${attempt.source}`
        );
      } else {
        this.output.appendLine(
          `[python] Rejected ${attempt.display} (${attempt.source}): ${attempt.error ?? 'unknown error'}`
        );
      }
    }

    this.cached = result.resolution ?? null;
    return this.cached;
  }

  async promptForSetup(reason: string): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'SQL Glyph cannot set up the local engine in an untrusted workspace. Trust the workspace and run the setup command again.'
      );
      return false;
    }

    const choice = await vscode.window.showWarningMessage(
      reason,
      'Set Up Engine',
      'Open Settings',
      'Show Output'
    );

    if (choice === 'Set Up Engine') {
      return this.setup();
    }
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'sqlGlyph.pythonPath');
      return false;
    }
    if (choice === 'Show Output') {
      this.output.show(true);
      return false;
    }
    return false;
  }

  async setup(): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'SQL Glyph cannot create a Python environment in an untrusted workspace.'
      );
      return false;
    }

    const interpreter = await this.pickInterpreter();
    if (!interpreter) {
      return false;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `SQL Glyph will create a private Python environment at:\n\n${this.managedVenvDir}\n\nIt will install sqlglot==${SQLGLOT_VERSION} from PyPI. This requires network access. Continue?`,
      { modal: true },
      'Set Up'
    );
    if (confirmed !== 'Set Up') {
      return false;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'SQL Glyph: setting up the local engine',
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Creating the private Python environment…' });
          await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);

          this.output.appendLine(`[setup] Creating virtual environment at ${this.managedVenvDir}`);
          const create = await runCommand(
            interpreter.command,
            [...interpreter.args, '-m', 'venv', this.managedVenvDir],
            {
              timeoutMs: 180000,
              onStdout: (chunk) => this.output.append(chunk),
              onStderr: (chunk) => this.output.append(chunk)
            }
          );
          if (create.code !== 0) {
            throw new Error(
              `Creating the Python environment failed (exit code ${String(create.code)}).\n${create.stderr}`
            );
          }

          progress.report({ message: `Installing SQLGlot ${SQLGLOT_VERSION}…` });
          this.output.appendLine(`[setup] Installing sqlglot==${SQLGLOT_VERSION}`);
          const install = await runCommand(
            this.managedPython,
            [
              '-m',
              'pip',
              'install',
              '--disable-pip-version-check',
              '--no-input',
              `sqlglot==${SQLGLOT_VERSION}`
            ],
            {
              timeoutMs: 300000,
              onStdout: (chunk) => this.output.append(chunk),
              onStderr: (chunk) => this.output.append(chunk)
            }
          );
          if (install.code !== 0) {
            throw new Error(
              `Installing SQLGlot failed (exit code ${String(install.code)}).\n${install.stderr}`
            );
          }

          progress.report({ message: 'Verifying SQLGlot…' });
          const sqlglotProbe = await runCommand(
            this.managedPython,
            ['-c', 'import sqlglot; print(sqlglot.__version__)'],
            { timeoutMs: 60000 }
          );
          if (sqlglotProbe.code !== 0) {
            throw new Error(
              `The new environment could not import SQLGlot (exit code ${String(
                sqlglotProbe.code
              )}).\n${sqlglotProbe.stderr}`
            );
          }
          const installedVersion = sqlglotProbe.stdout.trim();
          if (installedVersion !== SQLGLOT_VERSION) {
            throw new Error(
              `The new environment reports SQLGlot ${
                installedVersion || 'unknown'
              } instead of ${SQLGLOT_VERSION}.`
            );
          }

          progress.report({ message: 'Verifying the interpreter…' });
          const probe = await probePython(defaultExec, {
            command: this.managedPython,
            args: [],
            source: 'managed',
            display: this.managedPython
          });
          if (!probe.ok) {
            throw new Error(probe.error ?? 'The new environment could not run Python.');
          }

          const version = parsePythonVersion(probe.version ?? '');
          if (!version) {
            throw new Error('The new environment did not report a Python version.');
          }

          this.output.appendLine(
            `[setup] Ready: Python ${version.raw}, SQLGlot ${SQLGLOT_VERSION}, ${this.managedPython}`
          );
        }
      );

      this.cached = undefined;
      void vscode.window
        .showInformationMessage(
          `SQL Glyph local engine is ready. SQLGlot ${SQLGLOT_VERSION} is installed in the managed environment.`,
          'Show Output'
        )
        .then((choice) => {
          if (choice === 'Show Output') {
            this.output.show(true);
          }
        });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[setup] Failed: ${message}`);
      this.output.show(true);
      void vscode.window.showErrorMessage(
        `SQL Glyph could not set up the local engine: ${message}`,
        'Show Output',
        'Open Settings'
      ).then(async (choice) => {
        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'sqlGlyph.pythonPath');
        } else if (choice === 'Show Output') {
          this.output.show(true);
        }
      });
      return false;
    }
  }

  private async pickInterpreter(): Promise<PythonCommand | undefined> {
    const configured = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<string>('pythonPath', '')
      .trim();

    const attempts: PythonAttempt[] = [];
    const candidates = pythonCandidates({
      configuredPath: configured.length > 0 ? configured : undefined,
      platform: process.platform,
      includeManaged: false
    });
    for (const candidate of candidates) {
      attempts.push(await probePython(defaultExec, candidate));
    }

    const items: PythonPickItem[] = attempts
      .filter((attempt) => attempt.ok)
      .map((attempt) => ({
        label: attempt.display,
        description: `Python ${attempt.version ?? ''}`,
        detail: attempt.source === 'setting' ? 'Configured interpreter' : 'Detected on PATH',
        candidate: attempt
      }));

    items.push({
      label: '$(folder-opened) Browse for a Python interpreter…',
      detail: 'Select python.exe or a python executable',
      alwaysShow: true,
      browse: true
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'SQL Glyph: choose a Python 3.9+ interpreter',
      placeHolder:
        items.length > 1
          ? 'This interpreter is used only to create the private environment.'
          : 'No interpreter was detected automatically. Choose Browse to locate one.',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!picked) {
      return undefined;
    }

    if (!picked.browse && picked.candidate) {
      return picked.candidate;
    }

    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use Interpreter',
      title: 'Select a Python 3.9+ interpreter',
      filters:
        process.platform === 'win32'
          ? { 'Python executable': ['exe'] }
          : { 'Python executable': ['*'] }
    });
    if (!selection || selection.length === 0) {
      return undefined;
    }

    const command: PythonCommand = {
      command: selection[0].fsPath,
      args: [],
      source: 'setting',
      display: selection[0].fsPath
    };
    const attempt = await probePython(defaultExec, command);
    if (!attempt.ok) {
      void vscode.window.showErrorMessage(
        `That interpreter cannot be used: ${attempt.error ?? 'unknown error'}`
      );
      return undefined;
    }
    return command;
  }
}
