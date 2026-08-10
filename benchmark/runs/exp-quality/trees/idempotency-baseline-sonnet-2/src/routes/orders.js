'use strict';
const express = require('express');
const orderRepository = require('../data/orderRepository');
const { validateCreateOrderRequest } = require('../validation/orderValidation');
const logger = require('../logger');

const router = express.Router();

// Guards against two copies of the *same* retry racing each other (e.g. a client that times out and
// fires a second request before the first has finished writing the order). orderRepository's
// idempotency-key map only prevents duplicates once a row exists; this closes the gap while the first
// request is still in flight.
const inFlight = new Map();

router.post('/orders', async (req, res) => {
  const idempotencyKey = req.get('Idempotency-Key');

  if (!idempotencyKey || !idempotencyKey.trim()) {
    logger.warn('order.rejected', { reason: 'missing_idempotency_key' });
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  const validation = validateCreateOrderRequest(req.body);
  if (!validation.valid) {
    logger.warn('order.rejected', {
      idempotencyKey,
      reason: 'validation_failed',
      errors: validation.errors,
    });
    return res.status(400).json({ error: 'invalid request body', details: validation.errors });
  }

  logger.info('order.attempt', {
    idempotencyKey,
    itemCount: validation.value.items.length,
  });

  const alreadyStored = await orderRepository.findByIdempotencyKey(idempotencyKey);
  if (alreadyStored) {
    logger.info('order.replayed', { idempotencyKey, orderId: alreadyStored.id });
    return res.status(200).json(toResponse(alreadyStored));
  }

  if (inFlight.has(idempotencyKey)) {
    try {
      const order = await inFlight.get(idempotencyKey);
      logger.info('order.replayed', { idempotencyKey, orderId: order.id, concurrent: true });
      return res.status(200).json(toResponse(order));
    } catch {
      // The original attempt failed; fall through and let this request retry the creation.
    }
  }

  const creation = orderRepository.create({
    idempotencyKey,
    items: validation.value.items,
  });
  inFlight.set(idempotencyKey, creation);

  try {
    const order = await creation;
    logger.info('order.created', { idempotencyKey, orderId: order.id, totalPrice: order.totalPrice });
    return res.status(201).json(toResponse(order));
  } catch (err) {
    logger.error('order.failed', { idempotencyKey, error: err.message });
    return res.status(500).json({ error: 'failed to create order' });
  } finally {
    inFlight.delete(idempotencyKey);
  }
});

router.get('/orders', async (_req, res) => {
  const orders = await orderRepository.findAll();
  res.json(orders.map(toResponse));
});

function toResponse(order) {
  return {
    id: order.id,
    status: order.status,
    totalPrice: order.totalPrice,
    items: order.items.map(i => ({ sku: i.sku, quantity: i.quantity, unitPrice: i.unitPrice })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

module.exports = router;
