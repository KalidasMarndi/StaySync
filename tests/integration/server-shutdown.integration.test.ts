import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_REDIS_CONFIG } from '../helpers/redis';

/**
 * Runs the REAL API entry point (src/server.ts) as a child process — real
 * Redis connection, unreachable Temporal — and checks startup, health and
 * graceful shutdown on SIGTERM.
 */

const ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface LogLine {
  msg: string;
  [key: string]: unknown;
}

function startApi(port: number) {
  const logs: LogLine[] = [];
  const proc = spawn(TSX, ['src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', // JSON logs
      LOG_LEVEL: 'info',
      PORT: String(port),
      REDIS_HOST: TEST_REDIS_CONFIG.host,
      REDIS_PORT: String(TEST_REDIS_CONFIG.port),
      REDIS_DB: '15',
      TEMPORAL_ADDRESS: '127.0.0.1:1', // unreachable on purpose
      SUPPLIER_A_BASE_URL: `http://127.0.0.1:${port}/supplierA`,
      SUPPLIER_B_BASE_URL: `http://127.0.0.1:${port}/supplierB`,
      SUPPLIER_LATENCY_MS: '800',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        logs.push(JSON.parse(line) as LogLine);
      } catch {
        // ignore non-JSON output
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const waitForLog = async (msg: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (logs.some((l) => l.msg === msg)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`log "${msg}" not seen; got: ${logs.map((l) => l.msg).join(' | ')}`);
  };
  return { proc, logs, exited, waitForLog };
}

describe('API process lifecycle (real entry point)', () => {
  it('starts without Temporal, reports it accurately, and shuts down gracefully on SIGTERM', async () => {
    const port = await freePort();
    const api = startApi(port);
    await api.waitForLog('StaySync API listening');
    await api.waitForLog('Redis ready');
    const base = `http://127.0.0.1:${port}`;

    // Startup log names connection targets but never secrets.
    const startup = api.logs.find((l) => l.msg === 'StaySync API listening')!;
    expect(startup).toMatchObject({ port, redis: expect.stringContaining('/15') });
    expect(JSON.stringify(startup)).not.toMatch(/password/i);

    // Alive even though Temporal is down; /health reports exactly what is wrong.
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const health = (await (await fetch(`${base}/health`)).json()) as {
      status: string;
      services: Record<string, { status: string }>;
    };
    expect(health.status).toBe('degraded');
    expect(health.services.redis!.status).toBe('healthy');
    expect(health.services.temporal!.status).toBe('unhealthy');
    expect(health.services.worker!.status).toBe('unknown');

    // SIGTERM during an in-flight (800ms) request: the request must still complete.
    const inFlight = fetch(`${base}/supplierA/hotels?city=delhi`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    api.proc.kill('SIGTERM');

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveLength(8);
    expect(await api.exited).toBe(0);

    const messages = api.logs.map((l) => l.msg);
    expect(messages).toContain('Shutting down gracefully');
    expect(api.logs.find((l) => l.msg === 'StaySync API stopped')).toMatchObject({ clean: true });
    // New connections are refused after shutdown.
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });

  it('exits cleanly when SIGTERM arrives while a health probe is still retrying an unreachable Temporal', async () => {
    const port = await freePort();
    const api = startApi(port);
    await api.waitForLog('Redis ready');

    // The Temporal probe keeps retrying (gRPC backoff) until its 2s timeout.
    const healthInFlight = fetch(`http://127.0.0.1:${port}/health`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    api.proc.kill('SIGTERM');

    const health = await healthInFlight; // the in-flight request is still answered
    expect(health.status).toBe(200);
    expect(await api.exited).toBe(0); // no crash from SDK retry timers during shutdown
    expect(api.logs.find((l) => l.msg === 'StaySync API stopped')).toMatchObject({ clean: true });
    expect(api.logs.some((l) => /uncaught|unhandled/i.test(l.msg))).toBe(false);
  });
});
