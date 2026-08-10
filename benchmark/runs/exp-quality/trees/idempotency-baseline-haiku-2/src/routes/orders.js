'use strict';

const express = require('express');
const orderRepository = require('../data/orderRepository');

const router = express.Router();
const requestLog = [];

function logAttempt(idempotencyKey, customerId, attempt) {
  const entry = {
    timestamp: new Date().toISOString(),
    idempotencyKey,
    customerId,
    attempt,
  };
  requestLog.push(entry);
}

function validateOrderRequest(body) {
  const errors = [];

  if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim() === '') {
    errors.push('idempotencyKey is required and must be a non-empty string');
  }

  if (!body.customerId || typeof body.customerId !== 'string' || body.customerId.trim() === '') {
    errors.push('customerId is required and must be a non-empty string');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items is required and must be a non-empty array');
  } else {
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      if (!item.sku || typeof item.sku !== 'string') {
        errors.push(`items[${i}].sku is required and must be a string`);
      }
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        errors.push(`items[${i}].quantity is required and must be a positive number`);
      }
      if (typeof item.price !== 'number' || item.price <= 0) {
        errors.push(`items[${i}].price is required and must be a positive number`);
      }
    }
  }

  if (typeof body.totalPrice !== 'number' || body.totalPrice <= 0) {
    errors.push('totalPrice is required and must be a positive number');
  }

  return errors;
}

router.post('/orders', async (req, res) => {
  const { idempotencyKey, customerId, items, totalPrice } = req.body;

  const validationErrors = validateOrderRequest(req.body);
  if (validationErrors.length > 0) {
    logAttempt(idempotencyKey || 'unknown', customerId || 'unknown', 'validation_failed');
    return res.status(400).json({ error: 'Validation failed', details: validationErrors });
  }

  try {
    const { order, isNew } = await orderRepository.createOrder(
      idempotencyKey,
      customerId,
      items,
      totalPrice,
    );

    if (isNew) {
      logAttempt(idempotencyKey, customerId, 'created');
      res.status(201).json({ order, message: 'Order created successfully' });
    } else {
      logAttempt(idempotencyKey, customerId, 'duplicate_detected');
      res.status(200).json({ order, message: 'Order already exists (duplicate request)' });
    }
  } catch (err) {
    logAttempt(idempotencyKey, customerId, 'error');
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await orderRepository.findById(parseInt(req.params.id, 10));
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const orders = await orderRepository.findAll();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

router.get('/admin/request-log', (req, res) => {
  res.json(requestLog);
});

module.exports = router;
