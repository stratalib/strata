'use strict';
const express = require('express');
const productRepo = require('../data/productRepository');
const orderRepo = require('../data/orderRepository');
const { validateOrder } = require('../validation/orderValidation');

const router = express.Router();

// Small structured logger. One line per attempt so retries are visible in the log as repeats of the
// same idempotency key. Kept local rather than pulling in a logging dependency the project doesn't
// have; swap for a real logger later without touching call sites.
function log(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// POST /orders
// Requires an Idempotency-Key header. A client that retries the same order sends the same key; the
// first request creates the order, every retry returns that same order instead of creating another.
router.post('/orders', async (req, res) => {
  const key = req.get('Idempotency-Key');

  // Log the attempt first — before validation or dedupe — so even rejected attempts are recorded and
  // a retry shows up as a repeat of the same key.
  log({ event: 'order.attempt', idempotencyKey: key ?? null, itemCount: Array.isArray(req.body?.items) ? req.body.items.length : null });

  if (typeof key !== 'string' || key.trim() === '') {
    log({ event: 'order.rejected', reason: 'missing_idempotency_key' });
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  // Claim the key synchronously (no await before this point in the handler after reading it), which
  // makes check-and-reserve atomic against concurrent retries in this single-threaded process.
  const reservation = orderRepo.reserveKey(key);

  if (reservation.outcome === 'replay') {
    log({ event: 'order.replay', idempotencyKey: key, orderId: reservation.order.id });
    return res.status(200).json(reservation.order);
  }

  if (reservation.outcome === 'inflight') {
    // A concurrent request with the same key is already creating the order. Wait for it and return
    // the same result rather than creating a duplicate.
    try {
      const order = await reservation.promise;
      log({ event: 'order.replay', idempotencyKey: key, orderId: order.id, concurrent: true });
      return res.status(200).json(order);
    } catch (err) {
      // The in-flight request failed. Surface a retryable error; the key was released by its owner.
      log({ event: 'order.error', idempotencyKey: key, reason: 'inflight_failed' });
      return res.status(409).json({ error: 'a concurrent request for this key failed; please retry' });
    }
  }

  // outcome === 'reserved' — we own the key from here.
  const { settle, release } = reservation;
  try {
    const { valid, errors, value } = await validateOrder(req.body, productRepo);
    if (!valid) {
      // Release the key so a corrected retry with the same key can proceed instead of being wedged.
      release(new Error('validation_failed'));
      log({ event: 'order.rejected', idempotencyKey: key, reason: 'validation', errors });
      return res.status(400).json({ error: 'invalid order', details: errors });
    }

    const order = await orderRepo.insert({ ...value, idempotencyKey: key });
    settle(order);
    log({ event: 'order.created', idempotencyKey: key, orderId: order.id, total: order.total });
    return res.status(201).json(order);
  } catch (err) {
    release(err);
    log({ event: 'order.error', idempotencyKey: key, reason: 'exception', message: err.message });
    return res.status(500).json({ error: 'failed to create order' });
  }
});

router.get('/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid order id' });
  const order = await orderRepo.findById(id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  return res.json(order);
});

module.exports = router;
