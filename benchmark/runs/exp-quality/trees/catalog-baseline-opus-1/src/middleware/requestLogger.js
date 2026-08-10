'use strict';

// One structured log line per request, emitted after the response finishes so it can include the
// status code and duration — the fields you actually need when tracing. Every line carries req.id
// (set by the requestId middleware), so a single request is greppable end to end.
module.exports = function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip,
    };
    console.log(JSON.stringify(line));
  });
  next();
};
