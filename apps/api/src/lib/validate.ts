import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('داده‌های ارسالی معتبر نیست', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const body = <T extends z.ZodTypeAny>(req: Request, schema: T) => parse(schema, req.body ?? {});

export const uuid = z.string().uuid();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید به شکل YYYY-MM-DD باشد');

export function pageParams(req: Request) {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
  return { page, pageSize, offset: (page - 1) * pageSize, q };
}

export function param(req: Request, name: string): string {
  const v = req.params[name];
  const r = z.string().uuid().safeParse(v);
  if (!r.success) throw badRequest(`شناسه ${name} معتبر نیست`);
  return r.data;
}

export function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize };
}

/** Comma-separated list filter (?status=a,b); an empty value means "no filter". */
export function listParam(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}
