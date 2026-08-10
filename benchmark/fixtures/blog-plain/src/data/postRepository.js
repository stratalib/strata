'use strict';
let nextId = 1;
const rows = [];

function seed(n = 25) {
  if (rows.length) return rows;
  for (let i = 0; i < n; i++) {
    rows.push({
      id: nextId++,
      slug: `post-${i + 1}`,
      title: `Post ${i + 1}`,
      body: `Body of post ${i + 1}`,
      views: Math.floor(Math.random() * 5000),
      published: i % 4 !== 0,
      createdAt: new Date(Date.now() - i * 86_400_000),
    });
  }
  return rows;
}

async function findAll() { return seed(); }
async function insertMany(records) {
  const created = [];
  for (const r of records) {
    const row = { id: nextId++, published: false, createdAt: new Date(), ...r };
    rows.push(row);
    created.push(row);
  }
  return created;
}

module.exports = { findAll, insertMany, seed };
