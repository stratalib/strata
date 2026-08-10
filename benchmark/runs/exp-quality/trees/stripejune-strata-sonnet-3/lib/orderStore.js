'use strict';
const fs = require('fs');
const path = require('path');

// File-backed store, not a real database: this project has no DB specified, and a payment app
// cannot ship without SOME durable record of what was purchased and what was delivered. Swap this
// for Postgres/Mongo/etc by reimplementing these four methods against a real table — the queue and
// webhook code only call this interface, never the filesystem directly.
const DATA_DIR = process.env.ORDER_STORE_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Writes go through a temp file + rename so a crash mid-write can never leave orders.json
// truncated or half-written — the next read would otherwise silently lose every order.
function writeAll(data) {
  ensureFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/**
 * Create or update the order record for a Stripe checkout session.
 * Keyed on sessionId, which is stable across webhook redeliveries.
 */
function upsertOrder(sessionId, fields) {
  const all = readAll();
  const existing = all[sessionId] || { sessionId, createdAt: new Date().toISOString() };
  all[sessionId] = Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
  writeAll(all);
  return all[sessionId];
}

function getOrder(sessionId) {
  const all = readAll();
  return all[sessionId] || null;
}

function markReceiptSent(sessionId, receiptPath) {
  return upsertOrder(sessionId, { receiptSent: true, receiptPath, receiptSentAt: new Date().toISOString() });
}

module.exports = { upsertOrder, getOrder, markReceiptSent };
