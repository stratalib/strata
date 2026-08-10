'use strict';
const express = require('express');
const { validate } = require('../../strata/lib.js');
const orderRepository = require('../data/orderRepository');
const productRepository = require('../data/productRepository');

const router = express.Router();

// `items` is a list of objects ({sku, quantity}), which the generic `validate()` schema language
// (string/number/boolean/email/uuid/date/array-of-scalar) can't express — so it's checked by hand
// below, alongside `customerEmail`. Deliberately NOT using the `validateRequest` middleware here:
// it replaces req.body with only the schema's fields, which would silently drop `items`.
const createOrderSchema = {
  customerEmail: { type: 'email', required: true },
};

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'must be a non-empty array' };
  }
  if (items.length > 100) {
    return { ok: false, message: 'must have at most 100 line items' };
  }
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `item ${i} must be an object` };
    }
    if (typeof item.sku !== 'string' || item.sku.trim() === '') {
      return { ok: false, message: `item ${i}.sku is required` };
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return { ok: false, message: `item ${i}.quantity must be a positive integer` };
    }
  }
  return { ok: true };
}

router.post('/orders', async (req, res, next) => {
  try {
    req.log?.info(
      { idempotencyKey: req.headers['idempotency-key'], itemCount: Array.isArray(req.body?.items) ? req.body.items.length : 0 },
      'order creation attempted',
    );

    const emailCheck = validate(req.body, createOrderSchema);
    const itemsCheck = validateItems(req.body?.items);
    const errors = [];
    if (!emailCheck.ok) errors.push(...emailCheck.errors);
    if (!itemsCheck.ok) errors.push({ field: 'items', message: itemsCheck.message });
    if (errors.length) {
      return res.status(400).json({ error: 'validation failed', details: errors });
    }
    const customerEmail = emailCheck.value.customerEmail;

    const resolvedItems = [];
    for (const [i, item] of req.body.items.entries()) {
      const product = await productRepository.findBySku(item.sku);
      if (!product) {
        return res.status(400).json({
          error: 'validation failed',
          details: [{ field: `items[${i}].sku`, message: `no product with sku "${item.sku}"` }],
        });
      }
      if (!product.active) {
        return res.status(400).json({
          error: 'validation failed',
          details: [{ field: `items[${i}].sku`, message: `product "${item.sku}" is not active` }],
        });
      }
      resolvedItems.push({
        sku: product.sku,
        productId: product.id,
        quantity: item.quantity,
        unitPrice: product.price,
      });
    }

    const order = await orderRepository.create({
      items: resolvedItems,
      customerEmail,
    });

    req.log?.info({ orderId: order.id, itemCount: resolvedItems.length }, 'order created');
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await orderRepository.getById(req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
