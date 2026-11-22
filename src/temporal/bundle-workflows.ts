/**
 * Pre-builds the Temporal workflow bundle (run during `docker build`).
 *
 *   node dist/temporal/bundle-workflows.js [outputPath]
 *
 * The worker loads it via TEMPORAL_WORKFLOW_BUNDLE_PATH instead of running webpack at
 * every startup — Temporal's recommended setup for production: faster, deterministic
 * startup, and the workflow code is fixed when the image is built.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

async function main(): Promise<void> {
  const outputPath = path.resolve(process.argv[2] ?? path.join(__dirname, '../workflow-bundle.js'));
  const { code } = await bundleWorkflowCode({ workflowsPath: require.resolve('../workflows') });
  await writeFile(outputPath, code);
  console.log(`Workflow bundle written to ${outputPath} (${(code.length / 1024).toFixed(0)} KiB)`);
}

main().catch((err: unknown) => {
  console.error('Failed to bundle workflows', err);
  process.exit(1);
});
