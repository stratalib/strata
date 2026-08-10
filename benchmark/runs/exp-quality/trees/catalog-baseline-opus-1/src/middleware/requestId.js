'use strict';
const { randomUUID } = require('crypto');

// Stamps every request with a trace id. If an upstream (gateway, another service) already set
// X-Request-Id we keep it, so one logical request keeps the same id across hops; otherwise we mint
// one. The id is exposed on req.id for downstream handlers and echoed back in the response header so
// the caller can quote it when reporting a problem.
const HEADER = 'X-Request-Id';

// Guard against absurdly long or non-string client-supplied ids while still allowing normal trace ids.
function sanitize(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

module.exports = function requestId(req, res, next) {
  req.id = sanitize(req.get(HEADER)) || randomUUID();
  res.set(HEADER, req.id);
  next();
};
