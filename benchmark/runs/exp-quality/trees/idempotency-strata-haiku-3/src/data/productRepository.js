'use strict';
// Product data access. The rest of the app only ever touches products through this module — no route
// reaches into the store directly, so swapping the backing store never ripples outward.

const CATEGORIES = ['ELECTRONICS', 'HOME', 'TOYS', 'BOOKS', 'SPORTS'];

let nextId = 1;
const rows = [];

function seed(count = 40) {
  if (rows.length) return rows;
  for (let i = 0; i < count; i++) {
    rows.push({
      id: nextId++,
      sku: `SKU-${String(i + 1).padStart(5, '0')}`,
      name: `Product ${i + 1}`,
      description: i % 3 === 0 ? null : `Description for product ${i + 1}`,
      price: Math.round((5 + Math.random() * 500) * 100) / 100,
      quantity: i === 0 ? 100 : Math.floor(Math.random() * 200),
      category: CATEGORIES[i % CATEGORIES.length],
      active: i % 7 !== 0,
      createdAt: new Date(Date.now() - i * 86_400_000),
      updatedAt: new Date(Date.now() - i * 3_600_000),
    });
  }
  return rows;
}

async function findAll() {
  return seed();
}

async function findBySku(sku) {
  return seed().find(r => r.sku === sku) ?? null;
}

async function insertMany(records) {
  const created = [];
  for (const r of records) {
    const row = {
      id: nextId++,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...r,
    };
    rows.push(row);
    created.push(row);
  }
  return created;
}

module.exports = { findAll, findBySku, insertMany, seed, CATEGORIES };
