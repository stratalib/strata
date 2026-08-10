# Implementation Decisions

## Stripe Webhook Verification
- Used Strata's pre-built `payment.stripe-webhook.v1` module for signature verification
- Signature verification happens BEFORE body parsing to prevent HMAC mismatches
- 300-second tolerance for timestamp validation (Stripe default; prevents replay attacks on captured requests)
- Event deduplication prevents duplicate work from Stripe redeliveries

## Email Strategy
- Strata's `comm.email.v1` mailer with pluggable transport
- **Default mode (no MAIL_TRANSPORT)**: messages recorded in-memory for testing
- **Production mode (MAIL_TRANSPORT=smtp://...)**: real SMTP delivery via Nodemailer
- Supports any Nodemailer transport: Resend, SES, Postmark (modify server.js line 29-41 to swap)
- 3 retry attempts with 500ms exponential backoff by default

## Job Queue Strategy
- **BullMQ + Redis** for production persistence and distributed processing
- **In-memory fallback** when Redis unavailable (for testing without external deps)
- Receipt queue processes immediately in-memory mode; asynchronously via Redis in production
- Exponential backoff retry: 3 attempts, 2-second base delay

## Purchase Flow Architecture
Two separate operations on each checkout.session.completed event:
1. **Synchronous confirmation email**: sent immediately to acknowledge receipt
2. **Asynchronous receipt PDF**: queued for background processing

This allows:
- Fast acknowledgment to the customer (no PDF generation latency)
- Robust PDF generation (retries if SMTP fails)
- Ability to handle backpressure if PDF generation is slow

## PDF Generation
- PDFKit for in-memory PDF generation (no file I/O overhead)
- Generates simple receipt with order ID, email, amount, description, date
- Attached to confirmation email (not stored to disk or S3)
- For production scale: modify receipt-queue.js to persist PDFs before emailing

## Graceful Shutdown
- Servers shut down with SIGTERM/SIGINT
- HTTP server closes (stops accepting new requests)
- Receipt queue worker closes (completes in-flight jobs)
- Redis connection closes cleanly
- Process exits

## Error Handling
- **Webhook signature failures**: return 4xx, Stripe will retry
- **Event processing failures**: logged (won't retry—Stripe already got 200)
- **Email failures**: logged, queued jobs retry automatically
- **Redis connection failures**: warned but non-fatal (falls back to in-memory queue)
- **PDF generation failures**: job retries; onReceipt callback notified

## No Durable Storage for Failures
Currently:
- Failed emails: logged to console
- Failed PDF receipts: job retried until exhausted, then logged
- Dead letters: in-memory only

For production: wire `onDeadLetter` (server.js line 30-32) and `onReceipt` callbacks (line 47-51) to a database.

## Configuration Flexibility
- All Stripe settings configurable via env vars
- Email behavior controlled by MAIL_TRANSPORT presence
- Redis fallback automatic (no config needed for testing)
- Proxy configuration for X-Forwarded-For trust

## Testing
- `strata/verify.js`: Unit tests + integration tests (7/7 passing)
  - Signature verification (unsigned, forged, replayed, valid)
  - Deduplication on redelivery
  - Server health check
- `test-payment.js`: Helper to craft valid webhook signatures
- `test-integration.js`: Manual end-to-end flow test

All tests pass without Redis, SMTP, or external services.
