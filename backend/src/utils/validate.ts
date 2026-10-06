import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw badRequest('VALIDATION_ERROR', 'Certaines informations sont invalides', fields);
  }
  return r.data;
}
export const body = <T extends z.ZodTypeAny>(schema: T, req: Request) => parse(schema, req.body ?? {});
