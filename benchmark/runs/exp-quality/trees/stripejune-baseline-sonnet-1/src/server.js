const { createApp } = require('./app');
const { config } = require('./lib/config');

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
});
