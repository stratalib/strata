'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100; // hard ceiling so a caller can't ask for the whole table in one request

// Parse a positive-integer query param. Returns { value } on success or { error } with a message.
// We reject non-integers/junk with a 400 rather than silently coercing, so a typo fails loudly.
function parsePositiveInt(raw, name, { def, max }) {
  if (raw === undefined) return { value: def };
  if (!/^\d+$/.test(raw)) return { error: `${name} must be a positive integer` };
  const n = Number(raw);
  if (n < 1) return { error: `${name} must be >= 1` };
  return { value: max ? Math.min(n, max) : n };
}

router.get('/products', async (req, res) => {
  const pageResult = parsePositiveInt(req.query.page, 'page', { def: 1 });
  const limitResult = parsePositiveInt(req.query.limit, 'limit', { def: DEFAULT_LIMIT, max: MAX_LIMIT });

  const message = pageResult.error || limitResult.error;
  if (message) return res.status(400).json({ error: message, requestId: req.id });

  const page = pageResult.value;
  const limit = limitResult.value;
  const offset = (page - 1) * limit;

  const { items, total } = await productRepository.findPage({ offset, limit });
  const totalPages = Math.ceil(total / limit) || 1;

  res.json({
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  });
});

module.exports = router;
