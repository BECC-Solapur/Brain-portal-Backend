import { ZodTypeAny } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { ApiError, asyncHandler } from '../types/api';

type ValidateTarget = 'body' | 'query' | 'params';

export function validate<T extends ZodTypeAny>(
  schema: T,
  target: ValidateTarget = 'body'
) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const data = req[target];
    const result = schema.safeParse(data);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const field = firstIssue?.path?.join('.');
      throw ApiError.badRequest(
        'INPUT_VALIDATION_FAILED',
        firstIssue?.message || 'Validation failed',
        { field }
      );
    }
    (req as any)[target] = result.data;
    next();
  });
}
