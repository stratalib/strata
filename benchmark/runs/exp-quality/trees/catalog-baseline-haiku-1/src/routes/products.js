'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

router.get('/products', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 20));

    const allProducts = await productRepository.findAll();
    const total = allProducts.length;
    const totalPages = Math.ceil(total / pageSize);

    if (page > totalPages && totalPages > 0) {
      return res.status(400).json({
        error: 'Page out of range',
        page,
        totalPages,
        requestId: req.requestId,
      });
    }

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const products = allProducts.slice(start, end);

    res.json({
      data: products,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
      requestId: req.requestId,
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
