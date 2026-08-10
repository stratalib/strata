'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');
const { parseListQuery, applyQuery, paginateCursor } = require('../../strata/lib.js');

const router = express.Router();

const SORTABLE = ['id', 'name', 'price', 'category', 'quantity', 'createdAt'];
const FILTERABLE = ['category', 'active'];

router.get('/', async (req, res, next) => {
  try {
    const listQuery = parseListQuery(req.query, {
      sortable: SORTABLE,
      filterable: FILTERABLE,
      defaultSort: 'id',
    });

    const products = await productRepository.findAll();
    const filtered = applyQuery(products, listQuery, { idField: 'id' });
    const paginated = paginateCursor(filtered, listQuery, { idField: 'id' });

    res.json(paginated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
