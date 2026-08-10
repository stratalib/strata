'use strict';
// Order data access. In-memory, matching src/data/productRepository.js — see strata.guide.json,
// which says new entities use in-memory stores and Prisma is not wired up at runtime.

let nextId = 1;
const rows = [];

async function insert(order) {
  const row = {
    id: nextId++,
    createdAt: new Date(),
    ...order,
  };
  rows.push(row);
  return row;
}

async function findById(id) {
  return rows.find(r => r.id === id) ?? null;
}

async function findAll() {
  return rows;
}

module.exports = { insert, findById, findAll };
