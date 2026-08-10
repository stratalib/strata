'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

router.get('/products', async (req, res) => {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawPageSize = Number.parseInt(req.query.pageSize, 10);

  if (req.query.page !== undefined && (!Number.isInteger(rawPage) || rawPage < 1)) {
    return res.status(400).json({ error: 'page must be a positive integer', requestId: req.requestId });
  }
  if (req.query.pageSize !== undefined && (!Number.isInteger(rawPageSize) || rawPageSize < 1)) {
    return res.status(400).json({ error: 'pageSize must be a positive integer', requestId: req.requestId });
  }

  const page = Number.isInteger(rawPage) ? rawPage : 1;
  const pageSize = Math.min(Number.isInteger(rawPageSize) ? rawPageSize : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const { items, total, totalPages } = await productRepository.findPage({ page, pageSize });

  res.json({
    data: items,
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
