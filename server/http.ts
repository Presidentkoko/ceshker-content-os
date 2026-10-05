import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type output } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Wrap async handlers so thrown errors reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'Some fields are invalid.', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request.', details: err.issues });
  }
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code === '23505') {
    const map: Record<string, string> = {
      queue_live_target_uidx: 'This destination is already in the publishing queue.',
      publications_target_id_key: 'This destination has already been published. Duplicate publishing is blocked.',
    };
    return res.status(409).json({ error: map[pgErr.constraint ?? ''] ?? 'A record with these values already exists.' });
  }
  if (pgErr?.code === '22P02') return res.status(400).json({ error: 'Malformed identifier.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. The error has been logged.' });
}
