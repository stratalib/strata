const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATA_DIR = path.join(__dirname, '.tmp-data-orderstore');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { upsertOrder, getOrder, findByStripeEventId, markEventProcessed } = require('../src/services/orderStore');

test('upsertOrder creates and updates an order', () => {
  const created = upsertOrder({ id: 'order_1', customerEmail: 'a@example.com', amountTotal: 1000 });
  assert.equal(created.customerEmail, 'a@example.com');

  const updated = upsertOrder({ id: 'order_1', amountTotal: 2000 });
  assert.equal(updated.customerEmail, 'a@example.com'); // preserved
  assert.equal(updated.amountTotal, 2000); // overwritten

  const fetched = getOrder('order_1');
  assert.equal(fetched.amountTotal, 2000);
});

test('getOrder returns null for unknown id', () => {
  assert.equal(getOrder('does_not_exist'), null);
});

test('markEventProcessed + findByStripeEventId round trip', () => {
  upsertOrder({ id: 'order_2', customerEmail: 'b@example.com' });
  assert.equal(findByStripeEventId('evt_x'), null);

  markEventProcessed('order_2', 'evt_x');
  const found = findByStripeEventId('evt_x');
  assert.ok(found);
  assert.equal(found.id, 'order_2');
});

test('data survives process-level reload (persisted to disk)', () => {
  upsertOrder({ id: 'order_3', customerEmail: 'c@example.com' });
  delete require.cache[require.resolve('../src/services/orderStore')];
  const reloaded = require('../src/services/orderStore');
  const order = reloaded.getOrder('order_3');
  assert.ok(order);
  assert.equal(order.customerEmail, 'c@example.com');
});
