# Payment Processing System

## Architecture

The payment system processes Stripe webhook events and handles the complete purchase flow:

1. **Webhook Intake** (`server.js`): Verifies Stripe signatures using raw request bytes
2. **Purchase Confirmation** (`sendPurchaseConfirmation`): Sends immediate email to customer
3. **Background Jobs** (`lib/job-queue.js`): BullMQ + Redis queue for async receipt generation
4. **PDF Receipts** (`lib/receipt-generator.js`): PDFKit generates professional receipts
5. **Email Delivery** (`strata-composed`): Retry logic, dead letters, templating

## Key Components

### `server.js`
- Sets up Express app with Stripe webhook middleware
- Configures email transport (Nodemailer SMTP or test mode)
- Implements the purchase event handler
- Manages graceful shutdown of queue and worker

### `lib/receipt-generator.js`
- Uses PDFKit to generate PDF receipts in memory
- Formats order details, customer info, line items, totals
- Returns Buffer suitable for email attachments

### `lib/job-queue.js`
- Creates Redis connection for BullMQ
- Implements receipt queue and worker
- Worker generates PDF and emails it with retry logic
- Logs completion/failure events

### `lib/test-helpers.js`
- Mock data generation for testing
- Stripe signature creation (HMAC-SHA256)
- Fake checkout session events

## Payment Flow

```
Stripe Server
     ↓ (webhook POST)
/webhooks/stripe (signature verified)
     ↓
200 OK → Stripe (acknowledgement)
     ↓ (async, after response)
sendPurchaseConfirmation() → mailer.send()
     ↓
receiptQueue.add('receipt', {sessionId, email, orderData})
     ↓
Background Worker (picks up job)
     ↓
generateReceipt() → PDF buffer
     ↓
mailer.send() with PDF attachment
     ↓
Customer inbox (confirmation + detailed receipt)
```

## Testing

### Without Redis
```bash
STRIPE_WEBHOOK_SECRET=whsec_test node server.js
node examples/payment-demo.js
node test/send-webhook.js
```

The server starts without Redis. Confirmation emails are sent, but receipts skip the job queue with a warning.

### With Redis
```bash
redis-server                                    # Terminal 1
STRIPE_WEBHOOK_SECRET=whsec_test node server.js # Terminal 2
node test/send-webhook.js                       # Terminal 3
```

Full flow: signature verification → confirmation email → receipt generation → receipt email.

## Decisions Made

1. **Graceful Redis failure**: The server runs without Redis for testing/dev. Production deployments should exit if Redis is unavailable.

2. **Immediate confirmation emails**: Purchase confirmation is sent synchronously after webhook verification, before PDF generation. This reduces user wait time for at least one email.

3. **PDF generation in worker**: PDFKit runs in the background job, not the webhook handler. Avoids blocking webhook acknowledgement.

4. **One worker concurrency**: BullMQ worker processes receipts sequentially. Increase `concurrency: N` in `lib/job-queue.js` if needed.

5. **No custom email templates**: Uses simple HTML. Integrate a templating engine (handlebars, nunjucks) if needed.

6. **No event logging database**: Webhook event deduplication uses in-process Map. For production load-balancing, replace with Redis SETNX or database unique constraint on `event.id`.

7. **No order database**: This system doesn't persist orders. Integrate with your database in the `onEvent` handler to record purchases.

## Production Considerations

- **SMTP setup**: Configure `SMTP_URL` environment variable with your email provider credentials
- **Redis persistence**: Use `redis-py` or managed Redis (AWS ElastiCache, etc.)
- **Webhook secret rotation**: Stripe allows multiple secrets during rotation; the verifier handles this
- **Error monitoring**: Implement `onDeadLetter` callback in mailer config to track failed emails
- **Idempotency keys**: Add UUID idempotency keys to emails to prevent duplicates on job retries
- **Order persistence**: Store orders in database during `onEvent` handler
- **Payment status tracking**: Add order status updates (pending, confirmed, failed) to webhook handler
- **Refund handling**: Listen for `charge.refunded` events to update order status
