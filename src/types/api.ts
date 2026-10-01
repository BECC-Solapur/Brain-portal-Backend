import { Request, Response, NextFunction } from 'express';

export type UUID = string;
export type ISO8601 = string;
export type PaisaOrINR = number;

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  next?: string | null;
  prev?: string | null;
}

export type ApiErrorCode =
  | 'AUTH_UNAUTHENTICATED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_ROLE_INSUFFICIENT'
  | 'INPUT_VALIDATION_FAILED'
  | 'REFERRAL_CODE_INVALID'
  | 'REFERRAL_CODE_EXPIRED'
  | 'REFERRAL_CODE_USED_UP'
  | 'REFERRAL_CODE_NOT_ELIGIBLE_PROGRAM'
  | 'INQUIRY_NOT_FOUND'
  | 'INQUIRY_TRANSITION_INVALID'
  | 'INQUIRY_GUARD_VIOLATION'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PAYMENT_SIGNATURE_INVALID'
  | 'PAYMENT_ALREADY_PAID'
  | 'SLOT_DOUBLE_BOOKED'
  | 'NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR';

export class ApiError extends Error {
  public code: ApiErrorCode;
  public statusCode: number;
  public field?: string;
  public suggestion?: string;
  public requestId?: string;

  constructor(
    code: ApiErrorCode,
    message: string,
    statusCode: number = 400,
    extras?: { field?: string; suggestion?: string }
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.field = extras?.field;
    this.suggestion = extras?.suggestion;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(code: ApiErrorCode, message: string, extras?: { field?: string; suggestion?: string }) {
    return new ApiError(code, message, 400, extras);
  }

  static unauthenticated(message: string = 'Authentication required') {
    return new ApiError('AUTH_UNAUTHENTICATED', message, 401);
  }

  static forbidden(message: string = 'Access denied') {
    return new ApiError('AUTH_FORBIDDEN', message, 403);
  }

  static notFound(message: string = 'Resource not found') {
    return new ApiError('NOT_FOUND', message, 404);
  }

  static internal(message: string = 'An unexpected error occurred') {
    return new ApiError('INTERNAL_SERVER_ERROR', message, 500);
  }
}

export function success<T>(data: T, meta?: PaginationMeta): ApiSuccessResponse<T> {
  return {
    ok: true,
    data,
    meta,
    timestamp: new Date().toISOString(),
  };
}

export function failure(error: ApiError): ApiErrorResponse {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      field: error.field,
      suggestion: error.suggestion,
    },
    timestamp: new Date().toISOString(),
  };
}

export interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
  meta?: PaginationMeta;
  timestamp: ISO8601;
}

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    field?: string;
    suggestion?: string;
    requestId?: string;
  };
  timestamp: ISO8601;
}

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
