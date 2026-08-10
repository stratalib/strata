import express from 'express';
import Stripe from 'stripe';
import { config } from 'dotenv';
import { stripeWebhookHandler } from './handlers/webhook.js';
import { createOrderPaymentRoute } from './routes/orders.js';
import { initializeReceiptQueue, closeQueue } from './queue/receipt-queue.js';

config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize receipt queue
initializeReceiptQueue();

// Raw body parser for Stripe webhook signature verification
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// JSON body parser for all other routes
app.use(express.json());

// Routes
app.post('/api/orders', createOrderPaymentRoute);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = app.listen(port, () => {
  console.log(`Payment processor running on port ${port}`);
  console.log(`Webhooks ready at http://localhost:${port}/api/webhooks/stripe`);
});

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down gracefully...');
  server.close(async () => {
    await closeQueue();
    console.log('Server and queue closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default server;
