'use strict';
// In-memory stand-in shaped exactly like the Mongoose documents. Routes never touch the store
// directly, so swapping this for a real connection changes nothing above it.
const CONDITIONS = ['NEW', 'USED', 'REFURBISHED'];
let nextId = 1;
const rows = [];

function seed(n = 30) {
  if (rows.length) return rows;
  for (let i = 0; i < n; i++) {
    rows.push({
      _id: String(nextId++),
      sku: `ITEM-${String(i + 1).padStart(4, '0')}`,
      title: `Item ${i + 1}`,
      notes: i % 4 === 0 ? null : `Notes for item ${i + 1}`,
      price: Math.round((5 + Math.random() * 300) * 100) / 100,
      stock: Math.floor(Math.random() * 50),
      condition: CONDITIONS[i % CONDITIONS.length],
      listed: i % 6 !== 0,
      createdAt: new Date(Date.now() - i * 86_400_000),
    });
  }
  return rows;
}

async function findAll() { return seed(); }
async function insertMany(records) {
  const created = [];
  for (const r of records) {
    const row = { _id: String(nextId++), listed: true, createdAt: new Date(), ...r };
    rows.push(row);
    created.push(row);
  }
  return created;
}

module.exports = { findAll, insertMany, seed, CONDITIONS };
