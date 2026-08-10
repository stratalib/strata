'use strict';
const express = require('express');
const { validateRequest } = require('../../strata/lib.js');
const orderRepository = require('../data/orderRepository');
const productRepository = require('../data/productRepository');

const router = express.Router();

// Idempotent-Key dedup happens in app-level middleware (see src/server.js) — it wraps this whole
// route, so a retried POST with the same key never reaches this handler a second time. What is
// still ours to get right here: reject a body that is well-formed but not a real order (unknown
// SKU, more quantity than is in stock).
const createOrderSchema = {
  customerEmail: { type: 'email', required: true },
  items: { type: 'array', required: true, maxItems: 100 },
};

router.post('/orders', validateRequest(createOrderSchema), async (req, res, next) => {
  try {
    const { customerEmail, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'validation failed',
        details: [{ field: 'items', message: 'must be a non-empty array' }],
      });
    }

    const details = [];
    const lineItems = [];
    let index = -1;
    for (const rawItem of items) {
      index++;
      const sku = rawItem && typeof rawItem.sku === 'string' ? rawItem.sku.trim() : '';
      const quantity = rawItem ? Number(rawItem.quantity) : NaN;

      if (!sku) {
        details.push({ field: `items[${index}].sku`, message: 'is required' });
        continue;
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        details.push({ field: `items[${index}].quantity`, message: 'must be a positive whole number' });
        continue;
      }

      const product = await productRepository.findBySku(sku);
      if (!product) {
        details.push({ field: `items[${index}].sku`, message: `no product with sku "${sku}"` });
        continue;
      }
      if (!product.active) {
        details.push({ field: `items[${index}].sku`, message: `product "${sku}" is not active` });
        continue;
      }
      if (product.quantity < quantity) {
        details.push({ field: `items[${index}].quantity`, message: `only ${product.quantity} of "${sku}" in stock` });
        continue;
      }

      lineItems.push({ sku, quantity, unitPrice: product.price });
    }

    if (details.length) {
      return res.status(400).json({ error: 'validation failed', details });
    }

    const total = Math.round(lineItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0) * 100) / 100;

    const order = await orderRepository.insert({
      customerEmail,
      items: lineItems,
      total,
      status: 'CREATED',
    });

    req.log?.info({ orderId: order.id, itemCount: lineItems.length, total }, 'order created');

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'validation failed', details: [{ field: 'id', message: 'must be an integer' }] });
    }
    const order = await orderRepository.findById(id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
