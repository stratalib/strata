'use strict';

function validateOrderRequest(req, res, next) {
  const { idempotencyKey, items, customerId } = req.body;

  const errors = [];

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    errors.push('idempotencyKey is required and must be a non-empty string');
  }

  if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
    errors.push('customerId is required and must be a non-empty string');
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items is required and must be a non-empty array');
  } else {
    items.forEach((item, idx) => {
      if (!item.sku || typeof item.sku !== 'string') {
        errors.push(`items[${idx}].sku is required and must be a string`);
      }
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        errors.push(`items[${idx}].quantity must be a positive number`);
      }
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  next();
}

module.exports = { validateOrderRequest };
