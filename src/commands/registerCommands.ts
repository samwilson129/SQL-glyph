import * as vscode from 'vscode';
import type { EngineManager } from '../engine/engineManager';
import type { PythonEnvironment } from '../engine/pythonEnvironment';
import { EngineUnavailableError } from '../engine/errors';
import { BridgeError } from '../engine/pythonBridge';
import type { ConversionService } from '../services/conversionService';
import type { AstService } from '../services/astService';
import type { DialectService } from '../services/dialectService';
import type { DiagnosticService } from '../services/diagnosticService';
import type { SessionStore } from '../state/sessionStore';
import type { StatusBarController } from '../views/statusBar';
import type { AnalysisPanel } from '../views/analysisPanel';

export interface CommandDependencies {
  readonly engine: EngineManager;
  readonly environment: PythonEnvironment;
  readonly dialects: DialectService;
  readonly conversion: ConversionService;
  readonly ast: AstService;
  readonly analysis: AnalysisPanel;
  readonly conversionDiagnostics: DiagnosticService;
  readonly store: SessionStore;
  readonly statusBar: StatusBarController;
  readonly output: vscode.OutputChannel;
}

type CommandHandler = (...args: unknown[]) => Promise<void> | void;

function describeError(error: unknown): string {
  if (error instanceof EngineUnavailableError) {
    return error.message;
  }
  if (error instanceof BridgeError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function handleError(error: unknown, output: vscode.OutputChannel): Promise<void> {
  const message = describeError(error);
  output.appendLine(`[error] ${message}`);
  if (error instanceof Error && error.stack) {
    output.appendLine(error.stack);
  }

  const actions = ['Show Output'];
  if (error instanceof EngineUnavailableError) {
    actions.unshift('Set Up Engine');
  }
  const choice = await vscode.window.showErrorMessage(`SQL Glyph: ${message}`, ...actions);
  if (choice === 'Show Output') {
    output.show(true);
  } else if (choice === 'Set Up Engine') {
    await vscode.commands.executeCommand('sqlGlyph.setupEngine');
  }
}

function guard(
  output: vscode.OutputChannel,
  handler: CommandHandler
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    try {
      await handler(...args);
    } catch (error) {
      await handleError(error, output);
    }
  };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  dependencies: CommandDependencies
): void {
  const {
    engine,
    environment,
    dialects,
    conversion,
    ast,
    analysis,
    conversionDiagnostics,
    store,
    statusBar,
    output
  } = dependencies;

  const register = (command: string, handler: CommandHandler): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, guard(output, handler))
    );
  };

  register('sqlGlyph.convertSelection', async () => {
    await conversion.convert('selection');
  });

  register('sqlGlyph.convertDocument', async () => {
    await conversion.convert('document');
  });

  register('sqlGlyph.compareDialects', async () => {
    await conversion.compare();
  });

  register('sqlGlyph.inspectAst', async () => {
    await ast.inspectActiveScope();
  });

  register('sqlGlyph.showAnalysis', async () => {
    analysis.showLastOrPrompt();
  });

  register('sqlGlyph.selectSourceDialect', async () => {
    const picked = await dialects.pickSource();
    if (picked) {
      store.refresh();
    }
  });

  register('sqlGlyph.selectTargetDialect', async () => {
    const picked = await dialects.pickTarget();
    if (picked) {
      store.refresh();
    }
  });

  register('sqlGlyph.openConversionPanel', async () => {
    await vscode.commands.executeCommand('sqlGlyph.conversionView.focus');
  });

  register('sqlGlyph.setupEngine', async () => {
    const ready = await environment.setup();
    if (!ready) {
      statusBar.setEngine(engine.getSnapshot());
      return;
    }
    engine.reset();
    const healthy = await engine.ensureReady(false);
    statusBar.setEngine(engine.getSnapshot());
    store.refresh();
    if (!healthy) {
      void vscode.window.showWarningMessage(
        'SQL Glyph created the environment but the health check did not pass. Open the engine output for details.',
        'Show Output'
      ).then((choice) => {
        if (choice === 'Show Output') {
          output.show(true);
        }
      });
    }
  });

  register('sqlGlyph.showOutput', async () => {
    output.show(true);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('sqlGlyph.pythonPath') ||
        event.affectsConfiguration('sqlGlyph.engineTimeoutMs')
      ) {
        engine.reset();
        statusBar.setEngine(engine.getSnapshot());
        void engine.ensureReady(false).then(() => {
          statusBar.setEngine(engine.getSnapshot());
        });
      }
      if (
        event.affectsConfiguration('sqlGlyph.defaultSourceDialect') ||
        event.affectsConfiguration('sqlGlyph.defaultTargetDialect')
      ) {
        store.refresh();
      }
      if (
        event.affectsConfiguration('sqlGlyph.showConversionDiagnostics') &&
        !vscode.workspace
          .getConfiguration('sqlGlyph')
          .get<boolean>('showConversionDiagnostics', true)
      ) {
        conversionDiagnostics.clear();
      }
    })
  );
}
