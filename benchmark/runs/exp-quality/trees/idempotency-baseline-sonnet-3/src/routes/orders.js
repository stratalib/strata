'use strict';
const express = require('express');
const crypto = require('crypto');

const orderRepository = require('../data/orderRepository');
const productRepository = require('../data/productRepository');
const { validateOrderBody } = require('../validation/orderValidation');

const router = express.Router();

function logAttempt(fields) {
  // Structured, one-line-per-attempt logging so every retry is traceable by requestId/idempotencyKey
  // in log aggregation, not just the final outcome.
  console.log(JSON.stringify({ at: new Date().toISOString(), route: 'POST /orders', ...fields }));
}

router.post('/orders', async (req, res) => {
  const requestId = crypto.randomUUID();
  const body = req.body;
  const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : undefined;

  logAttempt({ requestId, idempotencyKey, event: 'received' });

  const errors = validateOrderBody(body);
  if (errors.length > 0) {
    logAttempt({ requestId, idempotencyKey, event: 'rejected', errors });
    return res.status(400).json({ error: 'validation_failed', details: errors });
  }

  // Confirm every referenced SKU actually exists in the catalog. Runs after shape validation so
  // errors are reported one class at a time instead of mixing "malformed" with "not found".
  const skuErrors = [];
  const seenSkus = new Map(); // sku -> product, to avoid duplicate lookups within one request
  for (const [i, item] of body.items.entries()) {
    let product = seenSkus.get(item.sku);
    if (product === undefined) {
      product = await productRepository.findBySku(item.sku);
      seenSkus.set(item.sku, product);
    }
    if (!product) {
      skuErrors.push(`items[${i}].sku "${item.sku}" does not match any product`);
    }
  }
  if (skuErrors.length > 0) {
    logAttempt({ requestId, idempotencyKey, event: 'rejected', errors: skuErrors });
    return res.status(400).json({ error: 'validation_failed', details: skuErrors });
  }

  const { order, created } = await orderRepository.insertIfAbsent(idempotencyKey, {
    customerEmail: body.customerEmail,
    items: body.items.map(item => ({ sku: item.sku, quantity: item.quantity })),
  });

  logAttempt({
    requestId,
    idempotencyKey,
    event: created ? 'created' : 'duplicate_replayed',
    orderId: order.id,
  });

  return res.status(created ? 201 : 200).json({ ...order, replayed: !created });
});

module.exports = router;
