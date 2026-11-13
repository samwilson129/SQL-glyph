/** User-facing error raised when the local Python engine cannot be used. */
export class EngineUnavailableError extends Error {
  public readonly code: string;
  public readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'EngineUnavailableError';
    this.code = code;
    this.hint = hint;
  }
}

export function isEngineUnavailableError(value: unknown): value is EngineUnavailableError {
  return value instanceof EngineUnavailableError;
}
