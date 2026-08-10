'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');

const router = express.Router();

router.get('/products', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const allProducts = await productRepository.findAll();
    const totalCount = allProducts.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;

    if (page > totalPages && totalCount > 0) {
      return res.status(404).json({
        error: 'Page not found',
        requestId: req.id,
        page,
        totalPages,
      });
    }

    const products = allProducts.slice(offset, offset + limit);

    res.json({
      requestId: req.id,
      data: products,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id,
    });
  }
});

module.exports = router;
