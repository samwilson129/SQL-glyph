import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PythonBridge,
  type PythonBridgeOptions,
  type SpawnFn
} from '../../src/engine/pythonBridge';

interface EngineRequest {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

interface FakeEngineOptions {
  readonly onRequest?: (request: EngineRequest, child: FakeChild) => void;
  readonly spawnError?: Error;
  readonly failSpawn?: boolean;
}

const bridges: PythonBridge[] = [];
const cleanups: Array<() => void> = [];

function createFakeEngine(options: FakeEngineOptions = {}): {
  spawnFn: SpawnFn;
  requests: EngineRequest[];
  children: FakeChild[];
} {
  const requests: EngineRequest[] = [];
  const children: FakeChild[] = [];

  const spawnFn: SpawnFn = () => {
    if (options.spawnError) {
      throw options.spawnError;
    }

    const child = new FakeChild();
    children.push(child);
    let buffer = '';

    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const request = JSON.parse(line) as EngineRequest;
          requests.push(request);
          if (request.action === 'shutdown') {
            child.stdout.write(
              `${JSON.stringify({
                id: request.id,
                success: true,
                status: 'success',
                shuttingDown: true
              })}\n`
            );
            setImmediate(() => child.emit('exit', 0, null));
          } else {
            options.onRequest?.(request, child);
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    if (options.failSpawn) {
      setImmediate(() => child.emit('error', new Error('spawn failed')));
    } else {
      setImmediate(() => child.emit('spawn'));
    }

    return child as unknown as ChildProcessWithoutNullStreams;
  };

  cleanups.push(() => {
    for (const child of children) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  return { spawnFn, requests, children };
}

function createBridge(
  spawnFn: SpawnFn,
  options: Partial<PythonBridgeOptions> = {}
): PythonBridge {
  const bridge = new PythonBridge({
    pythonPath: 'python',
    engineScript: 'main.py',
    timeoutMs: 1000,
    spawnFn,
    ...options
  });
  bridges.push(bridge);
  return bridge;
}

function respond(
  child: FakeChild,
  request: EngineRequest,
  payload: Record<string, unknown> = {}
): void {
  child.stdout.write(
    `${JSON.stringify({ id: request.id, success: true, status: 'success', ...payload })}\n`
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for a condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    try {
      await bridge.stop();
    } catch {
      // The fake process may already be gone.
    }
    bridge.dispose();
  }
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe('PythonBridge', () => {
  it('reports a synchronous start failure', async () => {
    const { spawnFn } = createFakeEngine({ spawnError: new Error('boom') });
    const bridge = createBridge(spawnFn);
    await expect(bridge.start()).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('reports an asynchronous spawn error', async () => {
    const { spawnFn } = createFakeEngine({ failSpawn: true });
    const bridge = createBridge(spawnFn);
    await expect(bridge.start()).rejects.toMatchObject({ code: 'ENGINE_START_FAILED' });
  });

  it('starts on demand and resolves the matching response', async () => {
    const { spawnFn, requests } = createFakeEngine({
      onRequest: (request, child) => respond(child, request, { pong: true })
    });
    const bridge = createBridge(spawnFn);

    const response = await bridge.request<{ pong: boolean }>('ping');

    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.pong).toBe(true);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('ping');
    expect(requests[0].payload).toEqual({});
    expect(bridge.isRunning).toBe(true);
  });

  it('serializes concurrent requests and routes responses by id', async () => {
    const pending: Array<{ request: EngineRequest; child: FakeChild }> = [];
    const { spawnFn, requests } = createFakeEngine({
      onRequest: (request, child) => pending.push({ request, child })
    });
    const bridge = createBridge(spawnFn);

    const first = bridge.request<{ pong: boolean }>('ping');
    const second = bridge.request<{ dialects: string[] }>('list_dialects');

    await waitFor(() => requests.length === 1);
    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('ping');

    respond(pending[0].child, pending[0].request, { pong: true });
    await waitFor(() => requests.length === 2);
    expect(requests[1].action).toBe('list_dialects');

    respond(pending[1].child, pending[1].request, { dialects: [] });
    const [a, b] = await Promise.all([first, second]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    if (b.success) {
      expect(b.dialects).toEqual([]);
    }
  });

  it('times out a stalled request and terminates the process', async () => {
    const { spawnFn, children } = createFakeEngine({ onRequest: () => undefined });
    const bridge = createBridge(spawnFn, { timeoutMs: 25 });

    await expect(bridge.request('ping')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(children[0].killed).toBe(true);
    expect(bridge.isRunning).toBe(false);
  });

  it('ignores unparseable output and still resolves', async () => {
    const logs: string[] = [];
    const { spawnFn } = createFakeEngine({
      onRequest: (request, child) => {
        child.stdout.write('this is not json\n');
        respond(child, request, { pong: true });
      }
    });
    const bridge = createBridge(spawnFn, { logger: (line) => logs.push(line) });

    const response = await bridge.request<{ pong: boolean }>('ping');
    expect(response.success).toBe(true);
    expect(logs.some((line) => line.includes('Unparseable engine output'))).toBe(true);
  });

  it('rejects requests after disposal', async () => {
    const { spawnFn } = createFakeEngine();
    const bridge = createBridge(spawnFn);
    bridge.dispose();

    await expect(bridge.request('ping')).rejects.toMatchObject({ code: 'DISPOSED' });
    await expect(bridge.start()).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('stops the process with a shutdown request', async () => {
    const { spawnFn, requests } = createFakeEngine({
      onRequest: (request, child) => respond(child, request, { pong: true })
    });
    const bridge = createBridge(spawnFn);

    await bridge.request('ping');
    await bridge.stop();

    expect(requests.some((request) => request.action === 'shutdown')).toBe(true);
    expect(bridge.isRunning).toBe(false);
  });

  it('rejects the active request when the process exits', async () => {
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    const { spawnFn } = createFakeEngine({
      onRequest: (_request, child) => {
        setImmediate(() => child.emit('exit', 1, null));
      }
    });
    const bridge = createBridge(spawnFn, {
      onExit: (code, signal) => exits.push([code, signal])
    });

    await expect(bridge.request('ping')).rejects.toMatchObject({ code: 'ENGINE_STOPPED' });
    expect(exits).toEqual([[1, null]]);
  });

  it('forwards stderr lines to the callback', async () => {
    const stderr: string[] = [];
    const { spawnFn } = createFakeEngine({
      onRequest: (request, child) => {
        child.stderr.write('engine warning\n');
        respond(child, request, { pong: true });
      }
    });
    const bridge = createBridge(spawnFn, {
      logger: () => undefined,
      onStderr: (line) => stderr.push(line)
    });

    await bridge.request('ping');
    await waitFor(() => stderr.includes('engine warning'));
  });
});
