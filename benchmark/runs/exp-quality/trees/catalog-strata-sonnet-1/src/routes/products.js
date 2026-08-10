'use strict';
const express = require('express');
const { applyQuery, listQueryMiddleware, paginateCursor, paginateOffset } = require('../../strata/lib.js');
const productRepository = require('../data/productRepository');

const router = express.Router();

// Allowlist: only these fields can be sorted/filtered on. A field left off this list is silently
// dropped from the query rather than passed through, so a caller can't sort on an arbitrary column.
const SORTABLE = ['id', 'name', 'price', 'quantity', 'createdAt', 'updatedAt'];
const FILTERABLE = ['category', 'active'];
const SEARCHABLE = ['name', 'sku', 'description'];

router.get(
  '/products',
  listQueryMiddleware({ sortable: SORTABLE, filterable: FILTERABLE }),
  async (req, res, next) => {
    try {
      const all = await productRepository.findAll();
      const rows = applyQuery(all, req.listQuery, { idField: 'id', searchFields: SEARCHABLE });

      // Cursor pagination is the default — stable while products are added/removed between page
      // fetches. ?offset= opts into offset paging for a UI that needs page numbers instead.
      res.json(req.query.offset !== undefined
        ? paginateOffset(rows, req.listQuery)
        : paginateCursor(rows, req.listQuery, { idField: 'id' }));
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
