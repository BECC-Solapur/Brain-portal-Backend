import { Request, Response, NextFunction } from 'express';
import { ApiError, failure } from '../types/api';
import env from '../config/env';
import { ZodError } from 'zod';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(ApiError.notFound('Endpoint not found'));
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    const firstIssue = err.issues[0];
    const field = firstIssue?.path?.join('.');
    const message = firstIssue?.message || 'Validation failed';
    const apiErr = ApiError.badRequest('INPUT_VALIDATION_FAILED', message, { field });
    return res.status(400).json(failure(apiErr));
  }

  if (err instanceof ApiError) {
    err.requestId = req.requestId;
    return res.status(err.statusCode).json(failure(err));
  }

  console.error(`[ERR] ${req.requestId}`, err);

  const internal = ApiError.internal(
    env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message || 'Internal server error'
  );
  internal.requestId = req.requestId;
  res.status(500).json(failure(internal));
}
