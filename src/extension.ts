import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { EngineManager } from './engine/engineManager';
import { PythonEnvironment } from './engine/pythonEnvironment';
import { AnalysisPanel } from './views/analysisPanel';
import { AstViewProvider } from './views/astView';
import { ConversionViewProvider } from './views/conversionView';
import { StatusBarController } from './views/statusBar';
import { AstService } from './services/astService';
import { ConversionService } from './services/conversionService';
import { DiagnosticService } from './services/diagnosticService';
import { DialectService } from './services/dialectService';
import { PreviewContentProvider } from './services/previewProvider';
import { SessionStore } from './state/sessionStore';

let activeEngine: EngineManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SQL Glyph');
  context.subscriptions.push(output);
  output.appendLine('SQL Glyph activating. Decipher. Transform. Transpile.');

  const environment = new PythonEnvironment(context, output);
  const engine = new EngineManager(context, output, environment);
  activeEngine = engine;

  const store = new SessionStore();
  const statusBar = new StatusBarController();
  const dialects = new DialectService(engine);
  const conversionDiagnostics = new DiagnosticService('conversion');
  const astDiagnostics = new DiagnosticService('ast');
  const preview = new PreviewContentProvider(output);

  const conversion = new ConversionService(
    engine,
    dialects,
    conversionDiagnostics,
    preview,
    store,
    statusBar,
    output
  );
  const ast = new AstService(engine, dialects, astDiagnostics, store, output);
  const analysis = new AnalysisPanel(context, store, conversion);
  const conversionView = new ConversionViewProvider(
    context,
    store,
    engine,
    dialects,
    conversion,
    ast
  );
  const astView = new AstViewProvider(context, store, engine, dialects, ast);

  context.subscriptions.push(
    engine,
    store,
    statusBar,
    conversionDiagnostics,
    astDiagnostics,
    preview,
    analysis,
    conversionView,
    astView
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PreviewContentProvider.scheme,
      preview
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConversionViewProvider.viewType,
      conversionView,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AstViewProvider.viewType, astView, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    engine.onDidChangeState((snapshot) => {
      statusBar.setEngine(snapshot);
    })
  );

  registerCommands(context, {
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
  });

  statusBar.setEngine(engine.getSnapshot());

  void engine
    .ensureReady(false)
    .then((ready) => {
      statusBar.setEngine(engine.getSnapshot());
      output.appendLine(`[startup] Engine ready: ${String(ready)}`);
    })
    .catch((error: unknown) => {
      output.appendLine(
        `[startup] Engine check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      statusBar.setEngine(engine.getSnapshot());
    });
}

export function deactivate(): void {
  activeEngine?.dispose();
  activeEngine = undefined;
}
