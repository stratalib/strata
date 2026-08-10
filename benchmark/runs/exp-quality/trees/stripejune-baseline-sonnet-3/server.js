const { validateEnv, env } = require('./src/config/env');

validateEnv();

const { createApp } = require('./src/app');
const { createConnection } = require('./src/lib/redis');
const { createReceiptWorker } = require('./src/jobs/receiptWorker');
const logger = require('./src/lib/logger');

const redisConnection = createConnection();
const app = createApp(redisConnection);
const worker = createReceiptWorker();

const server = app.listen(env.port, () => {
  logger.info(`Server listening on port ${env.port}`, { env: env.nodeEnv });
});

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down`);
  server.close();
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, worker };
