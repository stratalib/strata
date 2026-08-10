'use strict';

let nextId = 1;
const orders = [];

async function createOrder(idempotencyKey, customerId, items, totalPrice) {
  const existing = orders.find(o => o.idempotencyKey === idempotencyKey);
  if (existing) {
    return { order: existing, isNew: false };
  }

  const order = {
    id: nextId++,
    idempotencyKey,
    customerId,
    items,
    totalPrice,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  orders.push(order);
  return { order, isNew: true };
}

async function findByIdempotencyKey(idempotencyKey) {
  return orders.find(o => o.idempotencyKey === idempotencyKey) ?? null;
}

async function findById(id) {
  return orders.find(o => o.id === id) ?? null;
}

async function findAll() {
  return orders;
}

module.exports = { createOrder, findByIdempotencyKey, findById, findAll };
