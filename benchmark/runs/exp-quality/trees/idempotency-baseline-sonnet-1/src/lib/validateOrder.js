'use strict';
// Hand-rolled validation for the create-order request body. The service has no schema-validation
// library installed (see package.json), so this stays a plain function rather than pulling one in
// for a single endpoint's shape.

const MAX_ITEMS = 100;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// Returns { errors: string[] } — empty array means the body is valid.
function validateOrderBody(body) {
  const errors = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be a JSON object'] };
  }

  if (!isNonEmptyString(body.customerId)) {
    errors.push('customerId is required and must be a non-empty string');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items is required and must be a non-empty array');
  } else if (body.items.length > MAX_ITEMS) {
    errors.push(`items must not exceed ${MAX_ITEMS} entries`);
  } else {
    body.items.forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`items[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(item.sku)) {
        errors.push(`items[${i}].sku is required and must be a non-empty string`);
      }
      if (!isPositiveInt(item.quantity)) {
        errors.push(`items[${i}].quantity is required and must be a positive integer`);
      }
      if (!isPositiveNumber(item.unitPrice)) {
        errors.push(`items[${i}].unitPrice is required and must be a positive number`);
      }
    });
  }

  return { errors };
}

module.exports = { validateOrderBody };
