'use strict';
let nextId = 1;
const rows = [];
function seed(n = 20) {
  if (rows.length) return rows;
  for (let i = 0; i < n; i++) rows.push({ id: nextId++, name: 'invoice ' + (i + 1) });
  return rows;
}
async function findAll() { return seed(); }
async function insertMany(records) {
  const created = [];
  for (const r of records) { const row = { id: nextId++, ...r }; rows.push(row); created.push(row); }
  return created;
}
module.exports = { findAll, insertMany, seed };
