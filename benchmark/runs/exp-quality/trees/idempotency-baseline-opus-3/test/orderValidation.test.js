'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrder } = require('../src/validation/orderValidation');

const goodItem = { sku: 'SKU-00001', quantity: 2, unitPriceCents: 1500 };

test('accepts a well-formed order and normalizes it', () => {
  const { valid, value, errors } = validateOrder({
    customerId: '  cust-1 ',
    items: [{ ...goodItem, sku: ' SKU-00001 ' }],
  });
  assert.equal(valid, true, errors.join('; '));
  assert.equal(value.customerId, 'cust-1'); // trimmed
  assert.equal(value.items[0].sku, 'SKU-00001'); // trimmed
});

test('rejects a non-object body', () => {
  const { valid, errors } = validateOrder('nope');
  assert.equal(valid, false);
  assert.match(errors[0], /JSON object/);
});

test('rejects missing customerId', () => {
  const { valid, errors } = validateOrder({ items: [goodItem] });
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('customerId')));
});

test('rejects empty items array', () => {
  const { valid, errors } = validateOrder({ customerId: 'c', items: [] });
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('at least one item')));
});

test('rejects non-integer / non-positive quantity', () => {
  for (const bad of [0, -1, 1.5, '2', NaN]) {
    const { valid } = validateOrder({ customerId: 'c', items: [{ ...goodItem, quantity: bad }] });
    assert.equal(valid, false, `quantity ${String(bad)} should be invalid`);
  }
});

test('rejects negative or non-integer unitPriceCents', () => {
  for (const bad of [-1, 9.99, '100']) {
    const { valid } = validateOrder({ customerId: 'c', items: [{ ...goodItem, unitPriceCents: bad }] });
    assert.equal(valid, false, `unitPriceCents ${String(bad)} should be invalid`);
  }
});

test('collects multiple errors at once', () => {
  const { valid, errors } = validateOrder({ items: [{ sku: '', quantity: 0, unitPriceCents: -1 }] });
  assert.equal(valid, false);
  assert.ok(errors.length >= 3, `expected several errors, got ${errors.length}`);
});
