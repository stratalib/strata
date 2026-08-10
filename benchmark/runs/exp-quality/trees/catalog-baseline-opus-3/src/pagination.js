'use strict';
// Parses page/limit query params into safe, clamped values and builds the paged result envelope.
// Kept separate from the route so the clamping rules are testable in isolation.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Coerce a query param to a positive integer, falling back when it's missing or garbage.
function toPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function parseParams(query = {}) {
  const page = toPositiveInt(query.page, 1);
  const limit = Math.min(toPositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  return { page, limit };
}

// Slice `items` for the requested page and wrap it with pagination metadata.
function paginate(items, { page, limit }) {
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const data = items.slice(start, start + limit);

  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1 && total > 0,
    },
  };
}

module.exports = { parseParams, paginate, DEFAULT_LIMIT, MAX_LIMIT };
