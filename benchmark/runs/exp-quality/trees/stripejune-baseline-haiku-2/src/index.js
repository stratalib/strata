import express from 'express';
import { config } from './config/env.js';
import { getRedisClient, closeRedis } from './config/redis.js';
import { verifyStripeSignature } from './middleware/stripeWebhook.js';
import { startReceiptWorker } from './jobs/receiptJob.js';
import paymentRoutes from './routes/payment.js';
import webhookRoutes from './routes/webhook.js';

const app = express();

// Middleware for JSON parsing (except Stripe webhooks which need raw body)
app.use((req, res, next) => {
  if (req.path === '/webhooks/stripe') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Routes
app.use('/payments', paymentRoutes);

// Stripe webhook - needs raw body for signature verification
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), verifyStripeSignature, webhookRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Server startup
async function start() {
  try {
    console.log('Connecting to Redis...');
    await getRedisClient();

    console.log('Starting receipt worker...');
    await startReceiptWorker();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Webhook URL: http://localhost:${config.port}/webhooks/stripe`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await closeRedis();
  process.exit(0);
});

start();
