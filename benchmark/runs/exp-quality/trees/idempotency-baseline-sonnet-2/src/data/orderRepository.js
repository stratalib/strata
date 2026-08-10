'use strict';
// Order data access. Mirrors productRepository.js: routes never touch the store directly.
//
// The idempotencyKey index is what lets the route layer answer "have we already done this?" in O(1)
// instead of scanning — that lookup runs on every single order request, not just retries.

let nextOrderId = 1;
let nextItemId = 1;
const orders = [];
const byIdempotencyKey = new Map();

function findByIdempotencyKey(key) {
  const order = byIdempotencyKey.get(key);
  return order ?? null;
}

async function create({ idempotencyKey, items }) {
  const existing = findByIdempotencyKey(idempotencyKey);
  if (existing) return existing;

  const orderItems = items.map(item => ({
    id: nextItemId++,
    sku: item.sku,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    createdAt: new Date(),
  }));
  const totalPrice = Math.round(orderItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0) * 100) / 100;

  const order = {
    id: nextOrderId++,
    idempotencyKey,
    status: 'PENDING',
    totalPrice,
    items: orderItems,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  orders.push(order);
  byIdempotencyKey.set(idempotencyKey, order);
  return order;
}

async function findAll() {
  return orders;
}

module.exports = { create, findAll, findByIdempotencyKey };
