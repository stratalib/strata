'use strict';
const express = require('express');
const { validateRequest, idempotencyMiddleware } = require('../../strata/lib.js');
const productRepository = require('../data/productRepository');
const orderRepository = require('../data/orderRepository');

// `items` is validated as a JSON array by express.json() upstream; per-item shape (sku/quantity) is
// checked by hand below since the validator's `array` type only checks item count, not item shape.
const createOrderSchema = {
  customerEmail: { type: 'email', required: true },
  items: { type: 'array', required: true, maxItems: 100 },
  notes: { type: 'string', maxLength: 1000 },
};

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'items must be a non-empty array' };
  }
  const errors = [];
  const clean = [];
  items.forEach((item, idx) => {
    if (!item || typeof item !== 'object') {
      errors.push({ field: `items[${idx}]`, message: 'must be an object' });
      return;
    }
    const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
    const quantity = Number(item.quantity);
    if (!sku) {
      errors.push({ field: `items[${idx}].sku`, message: 'is required' });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push({ field: `items[${idx}].quantity`, message: 'must be a positive integer' });
    }
    clean.push({ sku, quantity });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: clean };
}

function buildOrdersRouter({ idempotencyStore }) {
  const router = express.Router();

  // Order creation must not silently double-run on a client retry, so — unlike the rest of the
  // app — a missing Idempotency-Key is itself a 400 here, not a pass-through. Runs before
  // validation/the handler so a replayed request never re-executes either.
  router.use('/orders', (req, res, next) => {
    if (req.method !== 'POST') return next();
    return idempotencyMiddleware(idempotencyStore, { required: true })(req, res, next);
  });

  router.post('/orders', validateRequest(createOrderSchema), async (req, res, next) => {
    try {
      const { customerEmail, notes } = req.body;
      const itemsResult = validateItems(req.body.items);

      if (!itemsResult.ok) {
        req.log?.warn({ customerEmail, errors: itemsResult.errors ?? itemsResult.message }, 'order rejected: invalid items');
        return res.status(400).json({
          error: 'validation failed',
          details: itemsResult.errors ?? [{ field: 'items', message: itemsResult.message }],
        });
      }

      const items = itemsResult.value;
      const resolved = [];
      const notFound = [];
      const stockErrors = [];
      for (const { sku, quantity } of items) {
        const product = await productRepository.findBySku(sku);
        if (!product) {
          notFound.push(sku);
          continue;
        }
        if (product.quantity < quantity) {
          stockErrors.push({ field: 'items', message: `insufficient stock for ${sku}: requested ${quantity}, available ${product.quantity}` });
          continue;
        }
        resolved.push({ sku, quantity, unitPrice: product.price, productId: product.id, name: product.name });
      }

      if (notFound.length) {
        req.log?.warn({ customerEmail, notFound }, 'order rejected: unknown sku');
        return res.status(422).json({
          error: 'unknown SKU(s)',
          details: notFound.map((sku) => ({ field: 'items', message: `no product with sku ${sku}` })),
        });
      }
      if (stockErrors.length) {
        req.log?.warn({ customerEmail, stockErrors }, 'order rejected: insufficient stock');
        return res.status(422).json({ error: 'insufficient stock', details: stockErrors });
      }

      const total = Math.round(resolved.reduce((sum, r) => sum + r.unitPrice * r.quantity, 0) * 100) / 100;
      const order = await orderRepository.create({ customerEmail, items: resolved, notes });

      req.log?.info({ orderId: order.id, customerEmail, total, itemCount: resolved.length }, 'order created');

      return res.status(201).json({
        id: order.id,
        customerEmail: order.customerEmail,
        items: order.items,
        notes: order.notes,
        status: order.status,
        total,
        createdAt: order.createdAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid order id' });
      const order = await orderRepository.findById(id);
      if (!order) return res.status(404).json({ error: 'order not found' });
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = buildOrdersRouter;
