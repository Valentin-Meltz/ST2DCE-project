import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.version, 'dev');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.db.host, 'localhost');
    assert.equal(config.db.port, 5432);
    assert.equal(config.db.ssl, false);
    assert.deepEqual({ ...config.fault }, { errorRate: 0, latencyMs: 0 });
  });

  it('reads values from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      APP_VERSION: 'abc1234',
      LOG_LEVEL: 'debug',
      DB_HOST: 'postgres',
      DB_PORT: '5433',
      DB_USER: 'u',
      DB_PASSWORD: 'p',
      DB_NAME: 'd',
      DB_SSL: 'true',
      DB_POOL_MAX: '5',
      FAULT_ERROR_RATE: '0.25',
      FAULT_LATENCY_MS: '300',
      SHUTDOWN_DELAY_MS: '5000',
    });
    assert.equal(config.port, 8080);
    assert.equal(config.version, 'abc1234');
    assert.equal(config.logLevel, 'debug');
    assert.deepEqual(
      { host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password },
      { host: 'postgres', port: 5433, user: 'u', password: 'p' },
    );
    assert.equal(config.db.database, 'd');
    assert.equal(config.db.ssl, true);
    assert.equal(config.db.poolMax, 5);
    assert.equal(config.fault.errorRate, 0.25);
    assert.equal(config.fault.latencyMs, 300);
    assert.equal(config.shutdownDelayMs, 5000);
  });

  it('is immutable', () => {
    const config = loadConfig({});
    // ES modules run in strict mode, so writing to a frozen object throws.
    assert.throws(() => {
      config.port = 1;
    }, TypeError);
  });

  const invalid = [
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['DB_PORT', '1.5'],
    ['LOG_LEVEL', 'verbose'],
    ['FAULT_ERROR_RATE', '1.5'],
    ['FAULT_ERROR_RATE', 'often'],
    ['FAULT_LATENCY_MS', '-10'],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}=${value}`, () => {
      assert.throws(() => loadConfig({ [name]: value }), new RegExp(name));
    });
  }
});
