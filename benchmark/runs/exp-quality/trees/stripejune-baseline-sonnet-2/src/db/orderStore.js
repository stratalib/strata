const fs = require('fs');
const path = require('path');

// Separate file under test so running the suite never mixes fixture data
// into (or clobbers) whatever a developer has running locally in tmp/orders.json.
const DB_FILENAME = process.env.NODE_ENV === 'test' ? 'orders.test.json' : 'orders.json';
const DB_PATH = path.join(__dirname, '..', '..', 'tmp', DB_FILENAME);

function readAll() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeAll(orders) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(orders, null, 2));
}

// Keyed by Stripe event id so re-delivered webhooks are a no-op (Stripe retries
// on any non-2xx response, and can also send the same event twice under normal
// operation, so the handler must be idempotent).
function hasProcessedEvent(eventId) {
  const orders = readAll();
  return Boolean(orders[eventId]);
}

function saveOrder(eventId, order) {
  const orders = readAll();
  orders[eventId] = order;
  writeAll(orders);
}

function getOrder(eventId) {
  const orders = readAll();
  return orders[eventId] || null;
}

module.exports = { hasProcessedEvent, saveOrder, getOrder };
