'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

router.get('/products', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));

  const all = productRepository.findAll();
  const total = all.length;
  const totalPages = Math.ceil(total / limit);

  if (page > totalPages && total > 0) {
    return res.status(400).json({
      error: 'Page out of range',
      page,
      totalPages,
      traceId: req.traceId,
    });
  }

  const start = (page - 1) * limit;
  const items = all.slice(start, start + limit);

  res.json({
    traceId: req.traceId,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    items,
  });
});

module.exports = router;
