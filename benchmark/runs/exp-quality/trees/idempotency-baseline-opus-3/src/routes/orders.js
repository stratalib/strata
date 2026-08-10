'use strict';
const express = require('express');
const crypto = require('crypto');
const orderRepository = require('../data/orderRepository');
const { validateOrder } = require('../validation/orderValidation');
const logger = require('../lib/logger');

const router = express.Router();

// POST /orders — create an order. Safe to retry: send the same `Idempotency-Key` header on the retry
// and you get the original order back instead of a duplicate.
router.post('/orders', (req, res) => {
  // A correlation id per HTTP attempt, so retries of "the same order" still show up as distinct log
  // lines while sharing one idempotency key — you can see exactly how many times a client tried.
  const attemptId = crypto.randomUUID();
  const idempotencyKey = req.get('Idempotency-Key') || null;

  logger.info('order.attempt', {
    attemptId,
    idempotencyKey,
    hasBody: req.body !== undefined && req.body !== null,
  });

  const { valid, errors, value } = validateOrder(req.body);
  if (!valid) {
    logger.warn('order.rejected', { attemptId, idempotencyKey, errors });
    return res.status(400).json({ error: 'ValidationError', details: errors });
  }

  let result;
  try {
    result = orderRepository.create({ ...value, idempotencyKey });
  } catch (err) {
    if (err.code === 'IDEMPOTENCY_KEY_REUSED') {
      // Same key, different order body. This is a client bug (or abuse) — refuse rather than silently
      // returning an unrelated order. 422: the request is well-formed but semantically conflicting.
      logger.warn('order.idempotency_conflict', { attemptId, idempotencyKey });
      return res.status(422).json({
        error: 'IdempotencyKeyReused',
        message: 'This Idempotency-Key was already used for a different order.',
      });
    }
    logger.error('order.error', { attemptId, idempotencyKey, message: err.message });
    return res.status(500).json({ error: 'InternalError' });
  }

  const { order, created } = result;
  logger.info(created ? 'order.created' : 'order.replayed', {
    attemptId,
    idempotencyKey,
    orderId: order.id,
    totalCents: order.totalCents,
  });

  // 201 for a freshly created order, 200 when we replayed an existing one for a repeated key — so a
  // client can distinguish "just created" from "already existed" without diffing state.
  return res.status(created ? 201 : 200).json(order);
});

router.get('/orders/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ValidationError', details: ['id must be a positive integer'] });
  }
  const order = orderRepository.findById(id);
  if (!order) return res.status(404).json({ error: 'NotFound' });
  return res.json(order);
});

module.exports = router;
