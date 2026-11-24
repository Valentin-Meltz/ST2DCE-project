import { notFound } from '../errors.js';

export function notFoundHandler(req, res, next) {
  next(notFound(`Route ${req.method} ${req.path} not found`));
}

export function errorHandler(logger) {
  // Express recognises error handlers by their 4-argument signature.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const log = req.log ?? logger;

    if (status >= 500) {
      log.error({ err, fault_injected: err.faultInjected === true }, 'request failed');
    }

    if (res.headersSent) {
      // Too late to send a clean error response: let Node close the connection.
      req.socket.destroy();
      return;
    }

    const message = status < 500 && err.expose !== false ? err.message : 'Internal Server Error';
    res.status(status).json({ error: { status, message, request_id: req.id } });
  };
}
