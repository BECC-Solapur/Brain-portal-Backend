import express from 'express';
import cors from 'cors';
import env from './config/env';
import { requestId } from './middleware/auth';
import { notFoundHandler, errorHandler } from './middleware/error';
import { routes } from './routes';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(requestId);

const configuredOrigins = env.cors.origin.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests or same-origin requests with no Origin header
    if (!origin) return callback(null, true);
    if (configuredOrigins.includes(origin)) return callback(null, true);
    try {
      const parsed = new URL(origin);
      if (parsed.hostname.endsWith('brainconsultancy.in') || parsed.hostname.endsWith('vercel.app')) {
        return callback(null, true);
      }
    } catch { /* ignore URL parse error */ }
    // In development or if localhost is explicitly permitted, allow any localhost/127.0.0.1 port
    if (env.NODE_ENV !== 'production' || configuredOrigins.some(o => o.includes('localhost'))) {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'X-Request-Id', 'X-File-Type', 'X-File-Name', 'X-AICMT-Metrics', 'Accept'],
}));

app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buffer) => {
    const expressReq = req as express.Request;
    if (expressReq.originalUrl.startsWith('/api/v1/payments/razorpay/webhook')) {
      expressReq.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'brain-edu-backend',
    version: '0.1.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
