'use strict';

let nextId = 1;
const rows = [];

async function create(data) {
  const order = {
    id: nextId++,
    createdAt: new Date(),
    ...data,
  };
  rows.push(order);
  return order;
}

async function findAll() {
  return rows;
}

async function findById(id) {
  return rows.find(r => r.id === id) ?? null;
}

module.exports = { create, findAll, findById };
