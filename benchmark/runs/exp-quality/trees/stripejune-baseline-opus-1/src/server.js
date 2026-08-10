'use strict';

const { createApp } = require('./app');
const { config, assertProductionConfig } = require('./config');

assertProductionConfig();

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Payment server listening on port ${config.port}`);
});

// Graceful shutdown so in-flight requests finish before we exit.
function shutdown(signal) {
  console.log(`${signal} received, shutting down server...`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server };
