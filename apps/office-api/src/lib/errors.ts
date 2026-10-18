export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'احراز هویت لازم است') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'شما مجوز انجام این عملیات را ندارید') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'یافت نشد') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, code, msg);
