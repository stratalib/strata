'use strict';
// Order data access, in-memory — mirrors the convention set by productRepository.js. No route
// touches `orders` directly; everything goes through the functions exported here.

const crypto = require('crypto');

const orders = [];

async function create({ items, customerEmail }) {
  const order = {
    id: crypto.randomUUID(),
    customerEmail,
    items,
    status: 'CREATED',
    createdAt: new Date(),
  };
  orders.push(order);
  return order;
}

async function getById(id) {
  return orders.find((o) => o.id === id) ?? null;
}

async function list() {
  return orders;
}

module.exports = { create, getById, list };
