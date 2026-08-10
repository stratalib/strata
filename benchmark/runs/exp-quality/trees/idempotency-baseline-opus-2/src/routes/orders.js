'use strict';
const express = require('express');
const orderRepo = require('../data/orderRepository');
const productRepo = require('../data/productRepository');
const log = require('../lib/logger');

const router = express.Router();

// How many order lines we'll accept in one request. A bound here stops a single request from pinning
// the event loop by asking us to validate/price ten thousand lines.
const MAX_ITEMS = 100;
const MAX_QTY_PER_LINE = 10_000;

// Validate the request body and return { ok, errors, value }. Pure function — no I/O, no store
// access — so it's trivial to unit-test and reason about. We collect ALL errors rather than bailing
// on the first, so a client fixing a bad request sees everything wrong in one round-trip.
function validateOrderBody(body) {
  const errors = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const { customerEmail, items } = body;

  if (typeof customerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    errors.push('customerEmail is required and must be a valid email address');
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items is required and must be a non-empty array');
  } else if (items.length > MAX_ITEMS) {
    errors.push(`items may contain at most ${MAX_ITEMS} lines`);
  } else {
    items.forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`items[${i}] must be an object`);
        return;
      }
      if (typeof item.sku !== 'string' || item.sku.trim() === '') {
        errors.push(`items[${i}].sku is required and must be a non-empty string`);
      }
      // Integer.isInteger rejects floats, NaN, Infinity, and non-numbers in one check — you can't
      // order 2.5 or "3" of a thing.
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QTY_PER_LINE) {
        errors.push(`items[${i}].quantity must be an integer between 1 and ${MAX_QTY_PER_LINE}`);
      }
    });
  }

  if (errors.length) return { ok: false, errors };

  // Normalise into exactly the shape the rest of the handler expects — trimmed sku, lowercased
  // email — so downstream code never re-derives it.
  return {
    ok: true,
    value: {
      customerEmail: customerEmail.trim().toLowerCase(),
      items: items.map(it => ({ sku: it.sku.trim(), quantity: it.quantity })),
    },
  };
}

// Look each SKU up, confirm it's active and in stock, and compute the line + order totals. Returns
// either a business error (unknown SKU, inactive, insufficient stock) or the priced order.
async function priceOrder(value) {
  const lines = [];
  let total = 0;

  for (const { sku, quantity } of value.items) {
    const product = await productRepo.findBySku(sku);
    if (!product || !product.active) {
      return { ok: false, status: 422, error: `unknown or unavailable sku: ${sku}` };
    }
    if (product.quantity < quantity) {
      return {
        ok: false,
        status: 409,
        error: `insufficient stock for ${sku}: requested ${quantity}, available ${product.quantity}`,
      };
    }
    const lineTotal = Math.round(product.price * quantity * 100) / 100;
    total += lineTotal;
    lines.push({ sku, name: product.name, quantity, unitPrice: product.price, lineTotal, product });
  }

  return { ok: true, lines, total: Math.round(total * 100) / 100 };
}

router.post('/orders', async (req, res) => {
  const key = req.get('Idempotency-Key');

  // We require the key on this endpoint. An order-creation call that can silently double-charge is a
  // real money bug, so we'd rather reject a request that forgot the key than risk a duplicate.
  if (!key || key.trim() === '') {
    log.warn('order.attempt.rejected', { reason: 'missing-idempotency-key' });
    return res.status(400).json({ error: 'Idempotency-Key header is required' });
  }

  log.info('order.attempt', { idempotencyKey: key });

  // Replay path: this key already produced a response. Return that exact response — same status,
  // same body — without creating anything. This is what makes a retry safe.
  const existing = orderRepo.beginKey(key);
  if (existing) {
    if (existing.status === 'done') {
      log.info('order.attempt.replayed', { idempotencyKey: key, statusCode: existing.statusCode });
      return res.status(existing.statusCode).json(existing.body);
    }
    // status === 'in-progress': the original request with this key hasn't finished yet. Don't
    // process a second time; tell the client we're still working on their first one.
    log.warn('order.attempt.in-progress', { idempotencyKey: key });
    return res.status(409).json({ error: 'a request with this Idempotency-Key is already in progress' });
  }

  // From here we hold the claim on `key`. Any early return MUST either store a response against the
  // key (so future retries replay it) or release the key (so future retries can proceed). A 4xx
  // caused by a bad/unprocessable request stores the result too: retrying an identical bad request
  // should get the identical answer, not surprise-succeed later.
  try {
    const validation = validateOrderBody(req.body);
    if (!validation.ok) {
      const body = { error: 'validation failed', details: validation.errors };
      orderRepo.completeKey(key, 400, body);
      log.warn('order.attempt.invalid', { idempotencyKey: key, errors: validation.errors });
      return res.status(400).json(body);
    }

    const priced = await priceOrder(validation.value);
    if (!priced.ok) {
      const body = { error: priced.error };
      orderRepo.completeKey(key, priced.status, body);
      log.warn('order.attempt.unprocessable', {
        idempotencyKey: key,
        statusCode: priced.status,
        reason: priced.error,
      });
      return res.status(priced.status).json(body);
    }

    // Commit: decrement stock for each line, then record the order.
    for (const line of priced.lines) {
      line.product.quantity -= line.quantity;
      line.product.updatedAt = new Date();
    }

    const order = await orderRepo.insert({
      customerEmail: validation.value.customerEmail,
      items: priced.lines.map(l => ({
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      total: priced.total,
    });

    const body = { order };
    orderRepo.completeKey(key, 201, body);
    log.info('order.created', { idempotencyKey: key, orderId: order.id, total: order.total });
    return res.status(201).json(body);
  } catch (err) {
    // Unexpected failure: release the key so the client can retry cleanly, and surface a 500.
    orderRepo.releaseKey(key);
    log.error('order.attempt.error', { idempotencyKey: key, message: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/orders/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid order id' });
  const order = await orderRepo.findById(id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  return res.json({ order });
});

module.exports = { router, validateOrderBody };
