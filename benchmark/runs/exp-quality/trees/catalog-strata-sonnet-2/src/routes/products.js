'use strict';
const express = require('express');
const productRepository = require('../data/productRepository');
const {
  applyQuery,
  listQueryMiddleware,
  paginateCursor,
  paginateOffset,
} = require('../../strata/lib.js');

const router = express.Router();

// Allowlist: a sort/filter field not named here is silently dropped rather than passed through.
const SORTABLE = ['id', 'name', 'sku', 'price', 'quantity', 'category', 'createdAt', 'updatedAt'];
const FILTERABLE = ['category', 'active'];
const SEARCHABLE = ['name', 'sku', 'description'];
const ID_FIELD = 'id';

router.get(
  '/',
  listQueryMiddleware({ sortable: SORTABLE, filterable: FILTERABLE }),
  async (req, res, next) => {
    try {
      const all = await productRepository.findAll();
      const rows = applyQuery(all, req.listQuery, { idField: ID_FIELD, searchFields: SEARCHABLE });

      // Cursor by default: stable while products are added/removed between pages.
      // ?offset= opts into offset paging for a UI that needs page numbers.
      res.json(req.query.offset !== undefined
        ? paginateOffset(rows, req.listQuery)
        : paginateCursor(rows, req.listQuery, { idField: ID_FIELD }));
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
