import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from '../errors.js';

// Incident-drill hook: adds latency and/or fails a fraction of requests with HTTP 500.
// Driven by FAULT_LATENCY_MS / FAULT_ERROR_RATE (see config.js); a no-op when both are 0.
export function faultInjection({ errorRate, latencyMs }, random = Math.random) {
  if (errorRate <= 0 && latencyMs <= 0) {
    return (req, res, next) => next();
  }

  return async (req, res, next) => {
    if (latencyMs > 0) await sleep(latencyMs);

    if (errorRate > 0 && random() < errorRate) {
      const err = new HttpError(500, 'Injected fault');
      err.faultInjected = true;
      throw err;
    }
    next();
  };
}
