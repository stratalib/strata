'use strict';

const { createApp } = require('./app');
const config = require('./config');
const logger = require('./lib/logger');

/**
 * Web server entrypoint: npm start
 *
 * Note the web process does NOT run the BullMQ worker. Run `npm run worker`
 * separately (own process, own scaling). The web process only enqueues jobs.
 */
function startServer() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('server listening', { port: config.port, env: config.env });
  });

  const shutdown = (signal) => {
    logger.info('server shutting down', { signal });
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
