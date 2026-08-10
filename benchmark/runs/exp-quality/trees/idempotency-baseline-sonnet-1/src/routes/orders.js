'use strict';
const express = require('express');
const crypto = require('crypto');
const orderRepository = require('../data/orderRepository');
const { validateOrderBody } = require('../lib/validateOrder');
const logger = require('../lib/logger');

const router = express.Router();

function getIdempotencyKey(req) {
  const header = req.get('Idempotency-Key');
  if (isNonEmptyString(header)) return header.trim();
  if (isNonEmptyString(req.body?.idempotencyKey)) return req.body.idempotencyKey.trim();
  return null;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

router.post('/orders', (req, res) => {
  const requestId = crypto.randomUUID();
  const idempotencyKey = getIdempotencyKey(req);

  if (!idempotencyKey) {
    logger.warn('order attempt rejected: missing idempotency key', { requestId });
    return res.status(400).json({
      error: 'Idempotency-Key header (or idempotencyKey body field) is required',
    });
  }

  logger.info('order attempt received', { requestId, idempotencyKey });

  const { errors } = validateOrderBody(req.body);
  if (errors.length > 0) {
    logger.warn('order attempt rejected: validation failed', { requestId, idempotencyKey, errors });
    return res.status(400).json({ error: 'validation failed', details: errors });
  }

  const reservation = orderRepository.reserve(idempotencyKey);

  if (reservation.status === 'already-completed') {
    logger.info('order attempt replayed: returning existing order', {
      requestId,
      idempotencyKey,
      orderId: reservation.order.id,
    });
    return res.status(200).json({ order: reservation.order, replayed: true });
  }

  if (reservation.status === 'in-flight') {
    logger.warn('order attempt rejected: concurrent request with same key still processing', {
      requestId,
      idempotencyKey,
    });
    return res.status(409).json({
      error: 'a request with this Idempotency-Key is already being processed',
    });
  }

  try {
    const order = orderRepository.create(idempotencyKey, {
      customerId: req.body.customerId,
      items: req.body.items,
    });
    logger.info('order created', { requestId, idempotencyKey, orderId: order.id });
    return res.status(201).json({ order, replayed: false });
  } catch (err) {
    orderRepository.release(idempotencyKey);
    logger.error('order attempt failed: unexpected error', {
      requestId,
      idempotencyKey,
      error: err.message,
    });
    return res.status(500).json({ error: 'internal error creating order' });
  }
});

router.get('/orders/:idempotencyKey', (req, res) => {
  const order = orderRepository.findByKey(req.params.idempotencyKey);
  if (!order) return res.status(404).json({ error: 'not found' });
  return res.json({ order });
});

module.exports = router;
