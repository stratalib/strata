'use strict';
// Order data access. In-memory store — see strata.guide.json: Prisma is aspirational and not wired
// up, so new entities (orders included) live in-memory like productRepository.js does.

let nextId = 1;
const orders = [];

async function create({ customerEmail, items, notes }) {
  const order = {
    id: nextId++,
    customerEmail,
    items,
    notes: notes ?? null,
    status: 'CREATED',
    createdAt: new Date(),
  };
  orders.push(order);
  return order;
}

async function findById(id) {
  return orders.find((o) => o.id === id) ?? null;
}

async function list() {
  return orders;
}

module.exports = { create, findById, list };
