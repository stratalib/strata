'use strict';
// Order data access with idempotency support.

let nextId = 1;
const orders = [];
const idempotencyIndex = new Map(); // Maps idempotencyKey -> order

function findByIdempotencyKey(key) {
  return idempotencyIndex.get(key) ?? null;
}

async function create(idempotencyKey, orderData) {
  const existing = findByIdempotencyKey(idempotencyKey);
  if (existing) {
    return existing;
  }

  const order = {
    id: nextId++,
    idempotencyKey,
    ...orderData,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  orders.push(order);
  idempotencyIndex.set(idempotencyKey, order);
  return order;
}

function findById(id) {
  return orders.find(o => o.id === id) ?? null;
}

function findAll() {
  return orders;
}

module.exports = { create, findById, findAll, findByIdempotencyKey };
