const { config } = require('./config/env');
const { createApp } = require('./app');

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] ${config.appName} listening on port ${config.port} (${config.env})`);
});
