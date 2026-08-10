'use strict';
// In-memory stand-in shaped exactly like the Drizzle rows.
const STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'];
let nextId = 1;
const rows = [];

function seed(n = 30) {
  if (rows.length) return rows;
  for (let i = 0; i < n; i++) {
    rows.push({
      id: nextId++,
      reference: `ORD-${String(i + 1).padStart(5, '0')}`,
      customer: `Customer ${i + 1}`,
      memo: i % 3 === 0 ? null : `Memo ${i + 1}`,
      total: Math.round((20 + Math.random() * 900) * 100) / 100,
      quantity: 1 + Math.floor(Math.random() * 9),
      status: STATUSES[i % STATUSES.length],
      rush: i % 5 === 0,
      createdAt: new Date(Date.now() - i * 3_600_000),
    });
  }
  return rows;
}

async function findAll() { return seed(); }
async function insertMany(records) {
  const created = [];
  for (const r of records) {
    const row = { id: nextId++, rush: false, createdAt: new Date(), ...r };
    rows.push(row);
    created.push(row);
  }
  return created;
}

module.exports = { findAll, insertMany, seed, STATUSES };
