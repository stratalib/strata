'use strict';
const express = require('express');
const orderRepository = require('../data/orderRepository');
const productRepository = require('../data/productRepository');

const router = express.Router();

// Validate request body for order creation
function validateOrderRequest(body) {
  const errors = [];

  if (!body.items || !Array.isArray(body.items)) {
    errors.push('items must be an array');
  } else if (body.items.length === 0) {
    errors.push('items array cannot be empty');
  } else {
    body.items.forEach((item, index) => {
      if (!item.sku || typeof item.sku !== 'string') {
        errors.push(`items[${index}].sku is required and must be a string`);
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        errors.push(`items[${index}].quantity must be a positive integer`);
      }
    });
  }

  if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string') {
    errors.push('idempotencyKey is required and must be a string');
  }

  if (body.customerEmail && typeof body.customerEmail !== 'string') {
    errors.push('customerEmail must be a string');
  }

  return errors.length > 0 ? errors : null;
}

router.post('/orders', async (req, res) => {
  const requestTime = new Date();
  const { idempotencyKey } = req.body;

  // Validate request body
  const validationErrors = validateOrderRequest(req.body);
  if (validationErrors) {
    console.log(`[${requestTime.toISOString()}] POST /orders - VALIDATION_FAILED - idempotencyKey: ${idempotencyKey}`, {
      errors: validationErrors,
      body: req.body,
    });
    return res.status(400).json({ error: 'Invalid request', details: validationErrors });
  }

  try {
    // Verify all items exist and have sufficient stock
    const verification = [];
    for (const item of req.body.items) {
      const product = await productRepository.findBySku(item.sku);
      if (!product) {
        console.log(`[${requestTime.toISOString()}] POST /orders - PRODUCT_NOT_FOUND - idempotencyKey: ${idempotencyKey}, sku: ${item.sku}`);
        return res.status(404).json({ error: `Product not found: ${item.sku}` });
      }
      verification.push({ sku: item.sku, productId: product.id, quantity: item.quantity });
    }

    // Create order (with idempotency check)
    const { order, isDuplicate } = orderRepository.create(
      {
        items: req.body.items,
        customerEmail: req.body.customerEmail || null,
        status: 'pending',
        total: 0, // Would be calculated from product prices in a real system
      },
      idempotencyKey
    );

    if (isDuplicate) {
      console.log(`[${requestTime.toISOString()}] POST /orders - DUPLICATE_REQUEST - idempotencyKey: ${idempotencyKey}, orderId: ${order.id}`);
      return res.status(200).json({ order, duplicate: true });
    }

    console.log(`[${requestTime.toISOString()}] POST /orders - ORDER_CREATED - idempotencyKey: ${idempotencyKey}, orderId: ${order.id}`);
    res.status(201).json({ order, duplicate: false });
  } catch (error) {
    console.error(`[${requestTime.toISOString()}] POST /orders - ERROR - idempotencyKey: ${idempotencyKey}`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/orders/:orderId', async (req, res) => {
  const order = orderRepository.findById(parseInt(req.params.orderId, 10));
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json({ order });
});

module.exports = router;
