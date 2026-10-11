export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'درخواست نامعتبر است', details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'احراز هویت لازم است', code = 'unauthorized') => new HttpError(401, msg, code);
export const forbidden = (msg = 'دسترسی مجاز نیست') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'یافت نشد') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');
export const tooMany = (msg = 'تعداد درخواست‌ها بیش از حد مجاز است', retryAfterSec?: number) =>
  new HttpError(429, msg, 'too_many_requests', retryAfterSec ? { retryAfterSec } : undefined);
export const upstream = (msg = 'سرویس بیرونی در دسترس نیست') => new HttpError(502, msg, 'upstream_error');
