'use strict';
const express = require('express');
const { validateRequest } = require('../../strata/lib.js');
const orderRepository = require('../data/orderRepository');
const productRepository = require('../data/productRepository');

const router = express.Router();

const orderSchema = {
  customerId: { type: 'string', required: true, minLength: 1 },
  productSku: { type: 'string', required: true, minLength: 1 },
  quantity: { type: 'number', required: true, min: 1, integer: true },
  unitPrice: { type: 'number', required: true, min: 0.01 },
};

router.post('/orders', validateRequest(orderSchema), async (req, res, next) => {
  try {
    const { customerId, productSku, quantity, unitPrice } = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    // Log the order attempt
    console.log(`[ORDER] Attempt customerId=${customerId} sku=${productSku} qty=${quantity} key=${idempotencyKey}`);

    // Validate product exists
    const product = await productRepository.findBySku(productSku);
    if (!product) {
      console.log(`[ORDER] Product not found sku=${productSku}`);
      return res.status(404).json({ error: 'Product not found' });
    }

    // Validate quantity available
    if (product.quantity < quantity) {
      console.log(`[ORDER] Insufficient stock sku=${productSku} requested=${quantity} available=${product.quantity}`);
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    // Create order (idempotency handled by repository)
    const order = await orderRepository.create(
      customerId,
      productSku,
      quantity,
      unitPrice,
      idempotencyKey
    );

    console.log(`[ORDER] Success id=${order.id} customerId=${customerId} sku=${productSku} qty=${quantity}`);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await orderRepository.findAll();
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
