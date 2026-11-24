export class HttpError extends Error {
  constructor(status, message, { expose = status < 500, cause } = {}) {
    super(message, { cause });
    this.name = 'HttpError';
    this.status = status;
    this.expose = expose;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message = 'Not Found') => new HttpError(404, message);
