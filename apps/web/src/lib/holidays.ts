import { ApiError } from './api';

/**
 * Sends a meeting date; when the server answers that the day is a holiday, asks the user and sends it again
 * with the confirmation. Returns null when the user changes their mind.
 */
export async function confirmHoliday<T>(send: (allowHoliday: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await send(false);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'holiday') throw e;
    if (!confirm(`${e.message}\n\nجلسه در همین روز ثبت شود؟`)) return null;
    return send(true);
  }
}
