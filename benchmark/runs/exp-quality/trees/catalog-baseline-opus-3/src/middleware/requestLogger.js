'use strict';
// Assigns every request a unique id, echoes it back as X-Request-Id, and logs one structured line
// per request on completion. The id is the thread you can grep for to trace a single request end to
// end across the logs.

const { randomUUID } = require('crypto');

function requestLogger(req, res, next) {
  // Honour an inbound id if a caller/proxy already set one (lets a trace span multiple services);
  // otherwise mint a fresh one.
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();

  // Log after the response is done so we know the status code and duration. 'finish' fires once the
  // response has been fully handed off.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = {
      level: 'info',
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(line));
  });

  next();
}

module.exports = requestLogger;
