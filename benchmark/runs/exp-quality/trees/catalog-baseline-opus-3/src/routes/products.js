'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');
const { parseParams, paginate } = require('../pagination');

const router = express.Router();

// GET /products — paginated list. Query params: page (>=1, default 1), limit (1..100, default 20).
router.get('/products', async (req, res, next) => {
  try {
    const params = parseParams(req.query);
    const all = await productRepository.findAll();
    res.json(paginate(all, params));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
