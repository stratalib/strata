'use strict';
// Order data access layer. Ensures all order writes go through this module for consistency.

let nextId = 1;
const orders = [];

async function findByIdempotencyKey(key) {
  return orders.find(o => o.idempotencyKey === key) ?? null;
}

async function create(customerId, productSku, quantity, unitPrice, idempotencyKey) {
  // Check if order with this idempotency key already exists
  const existing = await findByIdempotencyKey(idempotencyKey);
  if (existing) {
    return existing;
  }

  const totalPrice = quantity * unitPrice;
  const order = {
    id: nextId++,
    customerId,
    productSku,
    quantity,
    unitPrice,
    totalPrice,
    idempotencyKey,
    createdAt: new Date(),
  };

  orders.push(order);
  return order;
}

async function findAll() {
  return [...orders];
}

module.exports = { create, findByIdempotencyKey, findAll };
