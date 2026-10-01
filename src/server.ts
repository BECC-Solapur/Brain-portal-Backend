import app from './app';
import env from './config/env';
import { testConnection } from './config/db';

async function bootstrap() {
  console.log('========================================');
  console.log('  BRAIN Educational Center — Backend');
  console.log('========================================');
  console.log(`  Environment : ${env.NODE_ENV}`);
  console.log(`  Port        : ${env.PORT}`);
  console.log('');

  try {
    await testConnection();
  } catch (e: any) {
    console.warn('\n⚠️  Could not connect to database — starting anyway for health checks');
    console.warn(`   ${e.message}\n`);
  }

  const server = app.listen(env.PORT, () => {
    console.log(`\n🚀 Server listening on http://localhost:${env.PORT}`);
    console.log(`   Health check: http://localhost:${env.PORT}/health`);
    console.log(`   API base    : http://localhost:${env.PORT}/api/v1`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully`);
    server.close(async () => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
