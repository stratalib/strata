'use strict';
const express = require('express');
const orderRepository = require('../data/orderRepository');
const { validateOrderRequest } = require('../middleware/validation');
const logger = require('../utils/logger');

const router = express.Router();

function serializeOrder(order) {
  return {
    id: order.id,
    idempotencyKey: order.idempotencyKey,
    customerId: order.customerId,
    items: order.items,
    status: order.status,
    total: order.total,
    createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
    updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt,
  };
}

router.post('/orders', validateOrderRequest, async (req, res) => {
  const { idempotencyKey, items, customerId } = req.body;

  logger.info('Order request received', { idempotencyKey, customerId, itemCount: items.length });

  const existing = orderRepository.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info('Idempotent retry detected, returning existing order', {
      idempotencyKey,
      orderId: existing.id,
    });
    return res.status(200).json(serializeOrder(existing));
  }

  const order = await orderRepository.create(idempotencyKey, {
    customerId,
    items,
    status: 'created',
    total: items.reduce((sum, item) => sum + (item.quantity * (item.price || 0)), 0),
  });

  logger.info('Order created successfully', {
    idempotencyKey,
    orderId: order.id,
    customerId,
  });

  res.status(201).json(serializeOrder(order));
});

router.get('/orders/:id', (req, res) => {
  const order = orderRepository.findById(parseInt(req.params.id, 10));
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json(serializeOrder(order));
});

module.exports = router;
