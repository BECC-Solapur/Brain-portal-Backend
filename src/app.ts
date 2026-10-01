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

app.use(cors({
  origin: env.cors.origin.split(',').map(s => s.trim()).filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'X-Request-Id'],
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
