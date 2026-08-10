'use strict';
const express = require('express');
const { validateRequest, idempotencyMiddleware, createIdempotencyStore } = require('../../strata/lib.js');
const orderRepository = require('../data/orderRepository');

const router = express.Router();

// Idempotency store shared per-route
const orderIdempotencyStore = createIdempotencyStore({
  ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000),
});

// Validate order creation payload: customerId and items array required
const orderValidation = {
  customerId: { type: 'string', required: true, minLength: 1 },
  items: {
    type: 'array',
    required: true,
    maxItems: 100,
    of: 'string',
  },
};

// Idempotency middleware with required: true for POST /orders
const orderIdempotency = idempotencyMiddleware(orderIdempotencyStore, { required: true });

router.post('/orders',
  orderIdempotency,
  validateRequest(orderValidation),
  async (req, res, next) => {
    try {
      const { customerId, items } = req.body;

      req.log.info(
        { customerId, itemCount: items.length, idempotencyKey: req.headers['idempotency-key'] },
        'creating order',
      );

      const order = await orderRepository.create({ customerId, items });

      req.log.info({ orderId: order.id }, 'order created successfully');

      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  },
);

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await orderRepository.findAll();
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
