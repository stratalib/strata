'use strict';
// Pure request-body validation for orders — no Express in here on purpose, so it can be unit-tested
// without booting a server. Returns { valid, errors, value }. `value` is the normalized order when valid.

const MAX_ITEMS = 100;
const MAX_QUANTITY = 10_000;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Integer that is actually an integer — rejects NaN, Infinity, floats, and numeric strings like "3".
function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function validateItem(item, index, errors) {
  const at = `items[${index}]`;
  if (!isPlainObject(item)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  if (!isNonEmptyString(item.sku)) {
    errors.push(`${at}.sku is required and must be a non-empty string`);
  }
  if (!isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
    errors.push(`${at}.quantity is required and must be an integer between 1 and ${MAX_QUANTITY}`);
  }
  if (!isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
    errors.push(`${at}.unitPriceCents is required and must be a non-negative integer (price in cents)`);
  }
  return {
    sku: typeof item.sku === 'string' ? item.sku.trim() : item.sku,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
  };
}

function validateOrder(body) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { valid: false, errors: ['request body must be a JSON object'], value: null };
  }

  if (!isNonEmptyString(body.customerId)) {
    errors.push('customerId is required and must be a non-empty string');
  }

  if (!Array.isArray(body.items)) {
    errors.push('items is required and must be an array');
  } else if (body.items.length === 0) {
    errors.push('items must contain at least one item');
  } else if (body.items.length > MAX_ITEMS) {
    errors.push(`items must contain at most ${MAX_ITEMS} items`);
  }

  const normalizedItems = [];
  if (Array.isArray(body.items)) {
    body.items.forEach((item, i) => {
      const norm = validateItem(item, i, errors);
      if (norm) normalizedItems.push(norm);
    });
  }

  if (errors.length) {
    return { valid: false, errors, value: null };
  }

  return {
    valid: true,
    errors: [],
    value: {
      customerId: body.customerId.trim(),
      items: normalizedItems,
    },
  };
}

module.exports = { validateOrder, MAX_ITEMS, MAX_QUANTITY };
