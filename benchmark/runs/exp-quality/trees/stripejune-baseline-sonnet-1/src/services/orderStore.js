const fs = require('fs');
const path = require('path');
const { config } = require('../lib/config');

const DB_FILE = path.join(config.dataDir, 'orders.json');

function ensureDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({}), 'utf8');
  }
}

function readAll() {
  ensureDb();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeAll(orders) {
  ensureDb();
  const tmpFile = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

function upsertOrder(order) {
  const orders = readAll();
  orders[order.id] = { ...orders[order.id], ...order, updatedAt: new Date().toISOString() };
  writeAll(orders);
  return orders[order.id];
}

function getOrder(id) {
  const orders = readAll();
  return orders[id] || null;
}

function findByStripeEventId(eventId) {
  const orders = readAll();
  return Object.values(orders).find((o) => o.processedEventIds?.includes(eventId)) || null;
}

function markEventProcessed(orderId, eventId) {
  const orders = readAll();
  const order = orders[orderId];
  if (!order) return null;
  order.processedEventIds = order.processedEventIds || [];
  if (!order.processedEventIds.includes(eventId)) {
    order.processedEventIds.push(eventId);
  }
  order.updatedAt = new Date().toISOString();
  writeAll(orders);
  return order;
}

module.exports = {
  upsertOrder,
  getOrder,
  findByStripeEventId,
  markEventProcessed,
  _dbFile: DB_FILE,
};
