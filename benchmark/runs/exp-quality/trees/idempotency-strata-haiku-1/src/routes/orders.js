'use strict';
const express = require('express');
const { validate, idempotencyMiddleware, createIdempotencyStore } = require('../../strata/lib.js');

const router = express.Router();
const idempotencyStore = createIdempotencyStore();

const orderSchema = {
  customerId: { type: 'number', required: true, integer: true, min: 1 },
  items: {
    type: 'array',
    required: true,
    of: 'string',
    maxItems: 100,
  },
  total: { type: 'number', required: true, min: 0.01 },
};

let nextOrderId = 1;
const orders = [];

router.use(idempotencyMiddleware(idempotencyStore, { required: false }));

router.post('/orders', (req, res) => {
  req.log?.info({ body: req.body }, 'POST /orders received');

  const result = validate(req.body, orderSchema);
  if (!result.ok) {
    req.log?.warn({ errors: result.errors }, 'order validation failed');
    return res.status(400).json({
      error: 'validation failed',
      details: result.errors,
    });
  }

  const order = {
    id: nextOrderId++,
    customerId: result.value.customerId,
    items: result.value.items,
    total: result.value.total,
    createdAt: new Date(),
  };

  orders.push(order);
  req.log?.info({ orderId: order.id, customerId: order.customerId, total: order.total }, 'order created');

  res.status(201).json(order);
});

router.get('/orders', (req, res) => {
  res.json(orders);
});

router.get('/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === Number(req.params.id));
  if (!order) {
    return res.status(404).json({ error: 'order not found' });
  }
  res.json(order);
});

module.exports = router;
