'use strict';
const express = require('express');
const repo = require('../data/productRepository');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Parse a positive-integer query param, falling back to `fallback` for missing/garbage input and
// clamping into [min, max]. A read endpoint should be forgiving, so bad input degrades to defaults
// rather than 400-ing the caller.
function parsePositiveInt(value, fallback, { min = 1, max = Infinity } = {}) {
  const n = Number.parseInt(value, 10);
  // Not a number, or below the floor (e.g. 0 or negative) → treat as absent and use the default.
  // Only genuinely-too-large values get clamped down to max.
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

// GET /products?page=1&limit=20 — offset pagination over the catalog.
// We fetch through the repository (the only sanctioned door to product data) and slice here. Against a
// real DB you'd push skip/take into the query instead of loading everything; fine for the in-memory store.
router.get('/products', async (req, res, next) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, { min: 1 });
    const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });

    const all = await repo.findAll();
    const total = all.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const items = all.slice(offset, offset + limit);

    res.json({
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1 && page <= totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
