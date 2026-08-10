'use strict';
// Order data access and idempotency tracking. Each request must have a unique idempotencyKey
// to prevent duplicate orders from retried requests.

let nextOrderId = 1;
const orders = [];
const idempotencyMap = new Map(); // Maps idempotencyKey -> orderId for deduplication

function create(orderData, idempotencyKey) {
  // Check if we've already processed this request
  if (idempotencyMap.has(idempotencyKey)) {
    const existingOrderId = idempotencyMap.get(idempotencyKey);
    const existingOrder = orders.find(o => o.id === existingOrderId);
    return { order: existingOrder, isDuplicate: true };
  }

  const order = {
    id: nextOrderId++,
    ...orderData,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  orders.push(order);
  idempotencyMap.set(idempotencyKey, order.id);

  return { order, isDuplicate: false };
}

function findById(orderId) {
  return orders.find(o => o.id === orderId) ?? null;
}

function findAll() {
  return [...orders];
}

module.exports = { create, findById, findAll };
