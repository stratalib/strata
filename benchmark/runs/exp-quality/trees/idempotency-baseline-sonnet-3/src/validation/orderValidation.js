'use strict';
// Validates a POST /orders request body. Returns an array of error strings (empty = valid) instead
// of throwing, so the route can decide how to respond (and so this is trivial to unit test directly).

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateItem(item, index) {
  const errors = [];
  const path = `items[${index}]`;

  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return [`${path} must be an object`];
  }
  if (!isNonEmptyString(item.sku)) {
    errors.push(`${path}.sku is required and must be a non-empty string`);
  }
  if (typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) {
    errors.push(`${path}.quantity is required and must be a positive integer`);
  }
  return errors;
}

function validateOrderBody(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return ['request body must be a JSON object'];
  }

  if (!isNonEmptyString(body.idempotencyKey)) {
    errors.push('idempotencyKey is required and must be a non-empty string');
  }

  if (!isNonEmptyString(body.customerEmail)) {
    errors.push('customerEmail is required and must be a non-empty string');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customerEmail)) {
    errors.push('customerEmail must be a valid email address');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items is required and must be a non-empty array');
  } else {
    body.items.forEach((item, i) => errors.push(...validateItem(item, i)));
  }

  return errors;
}

module.exports = { validateOrderBody };
