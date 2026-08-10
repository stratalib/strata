'use strict';
// Validates the shape of an incoming order request body before it reaches the repository.
// Returns { valid: true, value } or { valid: false, errors }.

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isPositiveInteger(v) {
  return Number.isInteger(v) && v > 0;
}

function validateItem(item, index) {
  const errors = [];
  const prefix = `items[${index}]`;

  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return [`${prefix} must be an object`];
  }
  if (!isNonEmptyString(item.sku)) {
    errors.push(`${prefix}.sku must be a non-empty string`);
  }
  if (!isPositiveInteger(item.quantity)) {
    errors.push(`${prefix}.quantity must be a positive integer`);
  }
  if (!isPositiveNumber(item.unitPrice)) {
    errors.push(`${prefix}.unitPrice must be a positive number`);
  }
  return errors;
}

function validateCreateOrderRequest(body) {
  const errors = [];

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, errors: ['request body must be a JSON object'] };
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items must be a non-empty array');
  } else {
    body.items.forEach((item, i) => {
      errors.push(...validateItem(item, i));
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      items: body.items.map(item => ({
        sku: item.sku.trim(),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    },
  };
}

module.exports = { validateCreateOrderRequest };
