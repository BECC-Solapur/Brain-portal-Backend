import { Request, Response, NextFunction } from 'express';
import { ApiError, asyncHandler } from '../types/api';
import { query } from '../config/db';
import { parseBearer, verifyAccessToken, AccessTokenPayload } from '../utils/auth';

declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload & { userId: string };
      requestId: string;
      rawBody?: Buffer;
    }
  }
}

export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = crypto.randomUUID();
  next();
}

export function requireAuth() {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = parseBearer(req.headers.authorization);
    if (!token) throw ApiError.unauthenticated('Missing bearer token');

    let payload: AccessTokenPayload;
    try {
      payload = verifyAccessToken(token);
    } catch (e: any) {
      if (e.name === 'TokenExpiredError') {
        throw ApiError.unauthenticated('Token expired');
      }
      throw ApiError.unauthenticated('Invalid token');
    }

    const { rows } = await query<{ id: string; is_active: boolean; deleted_at: any }>(
      `SELECT id, is_active, deleted_at FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (rows.length === 0 || !rows[0].is_active || rows[0].deleted_at) {
      throw ApiError.unauthenticated('User not found or inactive');
    }

    req.auth = {
      ...payload,
      userId: payload.sub,
    };
    next();
  });
}

export function optionalAuth() {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = parseBearer(req.headers.authorization);
    if (!token) return next();

    try {
      const payload = verifyAccessToken(token);
      const { rows } = await query<{ id: string; is_active: boolean; deleted_at: any }>(
        `SELECT id, is_active, deleted_at FROM users WHERE id = $1`,
        [payload.sub]
      );
      if (rows.length > 0 && rows[0].is_active && !rows[0].deleted_at) {
        req.auth = {
          ...payload,
          userId: payload.sub,
        };
      }
    } catch {
      // Ignore invalid or expired token for optional auth
    }
    next();
  });
}

export function requireRoles(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw ApiError.unauthenticated();
    const hasRole = roles.some(r => req.auth!.roles.includes(r));
    if (!hasRole) {
      throw new ApiError(
        'AUTH_ROLE_INSUFFICIENT',
        `Required roles: ${roles.join(', ')}`,
        403
      );
    }
    next();
  };
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw ApiError.unauthenticated();
    if (!req.auth.permissions.includes(permission)) {
      throw new ApiError(
        'AUTH_ROLE_INSUFFICIENT',
        `Missing permission: ${permission}`,
        403
      );
    }
    next();
  };
}
