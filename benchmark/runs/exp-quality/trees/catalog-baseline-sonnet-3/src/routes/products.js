'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Clamp instead of rejecting bad page/pageSize values — an out-of-range page just means "empty page",
// and callers integrating against this API shouldn't get a 400 for passing pageSize=0 or page=-1.
function parsePagination(query) {
  let page = Number.parseInt(query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let pageSize = Number.parseInt(query.pageSize, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  return { page, pageSize };
}

router.get('/products', async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);

  const all = await productRepository.findAll();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);

  res.json({
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  });
});

module.exports = router;
