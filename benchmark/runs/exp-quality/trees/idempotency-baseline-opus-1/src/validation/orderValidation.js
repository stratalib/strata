'use strict';
// Pure validation for the create-order request body. No Express, no data mutation — it takes the raw
// parsed body and returns { valid, errors, value }. Keeping it pure means the route stays thin and
// this logic is testable on its own.
//
// productRepository is injected rather than required at module load so tests can pass a stub and so
// this module has no hidden dependency on the seeded store.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ITEMS = 100;
const MAX_QUANTITY = 10_000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Validate the body. `productRepo` must expose async findBySku(sku).
// Returns { valid: boolean, errors: string[], value?: normalizedOrder }.
async function validateOrder(body, productRepo) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { valid: false, errors: ['body must be a JSON object'] };
  }

  const { customerEmail, items } = body;

  if (typeof customerEmail !== 'string' || !EMAIL_RE.test(customerEmail)) {
    errors.push('customerEmail must be a valid email address');
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('items must be a non-empty array');
    // Nothing more to check on items if the container itself is wrong.
    return { valid: errors.length === 0, errors };
  }

  if (items.length > MAX_ITEMS) {
    errors.push(`items may contain at most ${MAX_ITEMS} entries`);
  }

  // Validate each item's shape first, collecting SKUs to resolve against the catalog. We resolve in
  // one pass afterwards so a big order doesn't fire lookups serially inside the loop.
  const shaped = [];
  items.forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.push(`items[${i}] must be an object`);
      return;
    }
    if (typeof item.sku !== 'string' || item.sku.trim() === '') {
      errors.push(`items[${i}].sku must be a non-empty string`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      errors.push(`items[${i}].quantity must be a positive integer`);
    } else if (item.quantity > MAX_QUANTITY) {
      errors.push(`items[${i}].quantity may not exceed ${MAX_QUANTITY}`);
    }
    shaped.push({ index: i, sku: item.sku, quantity: item.quantity });
  });

  // Only hit the catalog for items that were structurally valid — no point looking up a SKU we
  // already know is malformed.
  const resolvable = shaped.filter(
    s => typeof s.sku === 'string' && s.sku.trim() !== '' && Number.isInteger(s.quantity) && s.quantity > 0,
  );
  const products = await Promise.all(resolvable.map(s => productRepo.findBySku(s.sku)));

  const value = { customerEmail, items: [] };
  resolvable.forEach((s, k) => {
    const product = products[k];
    if (!product) {
      errors.push(`items[${s.index}].sku "${s.sku}" does not exist`);
      return;
    }
    if (product.active === false) {
      errors.push(`items[${s.index}].sku "${s.sku}" is not available`);
      return;
    }
    // Snapshot the price at order time so the order total is stable even if the catalog price changes
    // later — a bad property to leave floating.
    value.items.push({
      sku: product.sku,
      name: product.name,
      quantity: s.quantity,
      unitPrice: product.price,
      lineTotal: Math.round(product.price * s.quantity * 100) / 100,
    });
  });

  if (errors.length > 0) return { valid: false, errors };

  value.total = Math.round(value.items.reduce((sum, it) => sum + it.lineTotal, 0) * 100) / 100;
  return { valid: true, errors: [], value };
}

module.exports = { validateOrder };
