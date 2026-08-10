'use strict';
const express = require('express');
const { applyQuery, listQueryMiddleware, paginateCursor, paginateOffset } = require('../../strata/lib.js');
const productRepository = require('../data/productRepository');

const router = express.Router();

// Allowlist: a sort/filter field left out here is silently dropped, not honoured. Keeps a
// caller-supplied field name from ever reaching a comparison or query.
const PRODUCTS_SORTABLE = ['id', 'sku', 'name', 'price', 'quantity', 'category', 'createdAt', 'updatedAt'];
const PRODUCTS_FILTERABLE = ['category', 'active'];
const PRODUCTS_SEARCHABLE = ['sku', 'name'];
const PRODUCTS_ID = 'id';

router.get(
  '/products',
  listQueryMiddleware({ sortable: PRODUCTS_SORTABLE, filterable: PRODUCTS_FILTERABLE }),
  async (req, res, next) => {
    try {
      const all = await productRepository.findAll();
      const rows = applyQuery(all, req.listQuery, { idField: PRODUCTS_ID, searchFields: PRODUCTS_SEARCHABLE });

      // Cursor by default: stable while the catalog changes underneath a caller paging through it.
      // ?offset= opts into offset paging for a UI that needs page numbers.
      res.json(req.query.offset !== undefined
        ? paginateOffset(rows, req.listQuery)
        : paginateCursor(rows, req.listQuery, { idField: PRODUCTS_ID }));
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
