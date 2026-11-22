import path from 'node:path';
import { DefaultLogger, Runtime } from '@temporalio/worker';

export const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');

let installed = false;

/**
 * Keeps Temporal's own logs quiet in test output (errors only). Must run
 * before any Temporal connection or worker is created in the test process.
 */
export function installQuietTemporalRuntime(): void {
  if (installed) return;
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  installed = true;
}
