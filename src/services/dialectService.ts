import * as vscode from 'vscode';
import type { EngineManager } from '../engine/engineManager';
import type { Detection, DetectionCandidate, DetectionPayload } from '../types/protocol';
import {
  DEFAULT_TARGET_DIALECT,
  DIALECTS,
  dialectLabel,
  getDialect,
  isDialectId,
  isSourceDialectId,
  type DialectId,
  type SourceDialectId
} from '../types/dialect';

interface DialectPickItem extends vscode.QuickPickItem {
  readonly dialect?: DialectId;
  readonly source?: SourceDialectId;
}

export class DialectService {
  constructor(private readonly engine: EngineManager) {}

  getConfiguredSource(): SourceDialectId {
    const value = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<string>('defaultSourceDialect', 'auto');
    return isSourceDialectId(value) ? value : 'auto';
  }

  getConfiguredTarget(): DialectId {
    const value = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<string>('defaultTargetDialect', DEFAULT_TARGET_DIALECT);
    return isDialectId(value) ? value : DEFAULT_TARGET_DIALECT;
  }

  async setSource(dialect: SourceDialectId): Promise<void> {
    await vscode.workspace
      .getConfiguration('sqlGlyph')
      .update('defaultSourceDialect', dialect, vscode.ConfigurationTarget.Global);
  }

  async setTarget(dialect: DialectId): Promise<void> {
    await vscode.workspace
      .getConfiguration('sqlGlyph')
      .update('defaultTargetDialect', dialect, vscode.ConfigurationTarget.Global);
  }

  async pickSource(): Promise<SourceDialectId | undefined> {
    const current = this.getConfiguredSource();
    const items: DialectPickItem[] = [
      {
        label: 'Auto Detect',
        description: 'Heuristic detection with a confirmation prompt when uncertain',
        detail: 'Never silently assumes an ambiguous source dialect.',
        picked: current === 'auto',
        source: 'auto'
      },
      ...DIALECTS.map((dialect) => ({
        label: dialect.displayName,
        description: dialect.id,
        detail: dialect.description,
        picked: current === dialect.id,
        source: dialect.id
      }))
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'SQL Glyph: select the source dialect',
      placeHolder: 'The source dialect used for parsing',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked?.source) {
      return undefined;
    }
    await this.setSource(picked.source);
    return picked.source;
  }

  async pickTarget(): Promise<DialectId | undefined> {
    const current = this.getConfiguredTarget();
    const items: DialectPickItem[] = DIALECTS.map((dialect) => ({
      label: dialect.displayName,
      description: dialect.id,
      detail: dialect.description,
      picked: current === dialect.id,
      dialect: dialect.id
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'SQL Glyph: select the target dialect',
      placeHolder: 'The dialect SQLGlot generates',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked?.dialect) {
      return undefined;
    }
    await this.setTarget(picked.dialect);
    return picked.dialect;
  }

  /**
   * Resolves the concrete source dialect. Auto detection never proceeds on a
   * medium/low confidence result without an explicit choice.
   */
  async resolveSource(sql: string): Promise<DialectId | undefined> {
    const configured = this.getConfiguredSource();
    if (configured !== 'auto') {
      return configured;
    }

    const detection = await this.detect(sql);
    if (!detection) {
      return this.pickConcreteSource(
        'Dialect detection failed. Choose the source dialect manually.'
      );
    }

    const behavior = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<string>('autoDetectBehavior', 'notify');

    const recommended =
      detection.recommended && isDialectId(detection.recommended)
        ? detection.recommended
        : undefined;

    if (recommended && detection.confidence === 'high' && behavior !== 'alwaysAsk') {
      void vscode.window
        .showInformationMessage(
          `SQL Glyph detected the source dialect as ${dialectLabel(recommended)} with high confidence.`,
          'Change Source'
        )
        .then((choice) => {
          if (choice === 'Change Source') {
            void this.pickSource();
          }
        });
      return recommended;
    }

    return this.pickConcreteSource(
      recommended
        ? `Auto detection suggests ${dialectLabel(recommended)} (${detection.confidence} confidence). Confirm the source dialect.`
        : detection.note,
      detection.candidates
    );
  }

  async detect(sql: string): Promise<Detection | undefined> {
    try {
      const response = await this.engine.request<DetectionPayload>('detect_dialect', { sql });
      if (!response.success) {
        return undefined;
      }
      return response.detection;
    } catch {
      return undefined;
    }
  }

  private async pickConcreteSource(
    note: string,
    candidates: readonly DetectionCandidate[] = []
  ): Promise<DialectId | undefined> {
    const candidateIds = new Set(
      candidates
        .map((candidate) => candidate.dialect)
        .filter((dialect): dialect is DialectId => isDialectId(dialect))
    );

    const items: DialectPickItem[] = [];
    for (const candidate of candidates) {
      if (!isDialectId(candidate.dialect)) {
        continue;
      }
      const info = getDialect(candidate.dialect);
      const evidence =
        candidate.evidence.length > 0 ? candidate.evidence.join(' · ') : 'No dialect markers found';
      items.push({
        label: info?.displayName ?? candidate.dialect,
        description: `Detected · ${candidate.confidence} confidence · score ${candidate.score}`,
        detail: evidence,
        dialect: candidate.dialect
      });
    }

    for (const dialect of DIALECTS) {
      if (candidateIds.has(dialect.id)) {
        continue;
      }
      items.push({
        label: dialect.displayName,
        description: dialect.id,
        detail: dialect.description,
        dialect: dialect.id
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'SQL Glyph: confirm the source dialect',
      placeHolder: note,
      matchOnDescription: true,
      matchOnDetail: true
    });
    return picked?.dialect;
  }
}
