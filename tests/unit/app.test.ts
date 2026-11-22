import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { errorHandler } from '../../src/middleware/error.middleware';
import { requestLogger } from '../../src/middleware/request-logger.middleware';
import { DependencyUnavailableError, ValidationError } from '../../src/utils/errors';

describe('createApp', () => {
  const app = createApp(loadConfig({ NODE_ENV: 'test' }));

  it('serves the root service info on GET /', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'StaySync',
      description: 'Hotel Offer Orchestrator API',
      status: 'operational',
      deployment: 'Render',
      documentation: 'https://github.com/KalidasMarndi/StaySync#readme',
      endpoints: ['/health', '/health/live', '/health/ready', '/api/hotels?city=delhi'],
    });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist?secret=1');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Route GET /does-not-exist not found',
    });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('generates a request ID and echoes a safe caller-supplied one', async () => {
    const generated = await request(app).get('/x');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await request(app).get('/x').set('X-Request-Id', 'trace-123');
    expect(supplied.headers['x-request-id']).toBe('trace-123');

    const unsafe = await request(app).get('/x').set('X-Request-Id', 'bad id <script>');
    expect(unsafe.headers['x-request-id']).not.toBe('bad id <script>');
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/x');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const res = await request(app)
      .post('/anything')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('errorHandler', () => {
  function appThatThrows(error: unknown) {
    const app = express();
    app.use(requestLogger);
    app.get('/boom', () => {
      throw error;
    });
    app.use(errorHandler);
    return app;
  }

  it('maps AppError subclasses to their status code and code', async () => {
    const res = await request(appThatThrows(new ValidationError('city is required'))).get('/boom');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'city is required' });
  });

  it('maps dependency failures to 503 with the dependency name', async () => {
    const res = await request(
      appThatThrows(new DependencyUnavailableError('redis', 'Cache is unavailable')),
    ).get('/boom');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: { dependency: 'redis' },
    });
  });

  it('hides internal details of unexpected errors', async () => {
    const res = await request(appThatThrows(new Error('db password is hunter2'))).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });
});
