import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env';

describe('loadConfig', () => {
  it('applies sensible defaults when nothing is set', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(4000);
    expect(config.redis).toEqual({ host: 'localhost', port: 6379, db: 0, password: undefined });
    expect(config.temporal.taskQueue).toBe('hotel-offers');
    expect(config.temporal.workflowBundlePath).toBeUndefined(); // bundle at startup locally
    expect(config.suppliers.supplierA.enabled).toBe(true);
    expect(config.suppliers.failureSimulationEnabled).toBe(false);
    expect(config.cache).toEqual({ ttlSeconds: 300, degradedTtlSeconds: 30 });
  });

  it('parses the string "false" as boolean false (not truthy)', () => {
    const config = loadConfig({ SUPPLIER_A_ENABLED: 'false', SUPPLIER_B_ENABLED: 'true' });

    expect(config.suppliers.supplierA.enabled).toBe(false);
    expect(config.suppliers.supplierB.enabled).toBe(true);
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ PORT: '8080', REDIS_PORT: '6380', CACHE_TTL_SECONDS: '60' });

    expect(config.port).toBe(8080);
    expect(config.redis.port).toBe(6380);
    expect(config.cache.ttlSeconds).toBe(60);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['SUPPLIER_A_ENABLED', 'yes'],
    ['SUPPLIER_A_BASE_URL', 'not-a-url'],
    ['SUPPLIER_A_BASE_URL', 'http://localhost:4000/supplierA SUPPLIER_B_BASE_URL=http://x'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('reads the optional pre-built workflow bundle path (set in the Docker image)', () => {
    const config = loadConfig({ TEMPORAL_WORKFLOW_BUNDLE_PATH: '/app/dist/workflow-bundle.js' });
    expect(config.temporal.workflowBundlePath).toBe('/app/dist/workflow-bundle.js');
  });

  it('refuses to enable failure simulation in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ENABLE_FAILURE_SIMULATION: 'true' })).toThrow(
      /ENABLE_FAILURE_SIMULATION: must not be enabled when NODE_ENV=production/,
    );
  });

  it('allows failure simulation outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development', ENABLE_FAILURE_SIMULATION: 'true' });
    expect(config.suppliers.failureSimulationEnabled).toBe(true);
  });

  it('rejects a degraded TTL longer than the normal TTL', () => {
    expect(() => loadConfig({ CACHE_TTL_SECONDS: '10', DEGRADED_CACHE_TTL_SECONDS: '30' })).toThrow(
      /DEGRADED_CACHE_TTL_SECONDS/,
    );
  });
});
