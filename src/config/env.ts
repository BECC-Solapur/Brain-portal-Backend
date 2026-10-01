import dotenv from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test'
  ? '.env.test'
  : process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env';

dotenv.config({ path: path.resolve(__dirname, '..', '..', envFile) });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),

  db: {
    host: requireEnv('POSTGRES_HOST', 'localhost'),
    port: parseInt(requireEnv('POSTGRES_PORT', '5432'), 10),
    user: requireEnv('POSTGRES_USER', 'postgres'),
    password: process.env.POSTGRES_PASSWORD || '',
    database: requireEnv('POSTGRES_DB', 'brain_edu_portal'),
  },

  jwt: {
    accessSecret: requireEnv('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
    refreshSecret: requireEnv('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
    accessTtlMinutes: parseInt(process.env.JWT_ACCESS_TTL_MINUTES || '15', 10),
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '7', 10),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
};

export default env;
