'use strict';
// Strata wiring for an EXISTING Express app.
//
// This project already has an entry point, so Strata does not generate a competing one. It exports
// four functions that mount into your app, in the only order that works:
//
//   before(app)          — request logger, rate limiter. Must run ahead of EVERYTHING, including your
//                          own body parser: a malformed-JSON request throws inside express.json(), and
//                          if the logger hasn't run yet, the one request you most want to trace has no
//                          correlation id.
//   afterBodyParse(app)  — middleware that needs req.body (e.g. idempotency-key fingerprinting). Runs
//                          after whichever body parser wins — yours if your entry point already has
//                          one, ours if it doesn't.
//   routes(app)          — the endpoints this task asked for.
//   after(app)           — the error handler. Must be registered LAST, after every route.
//
require('dotenv').config();
const express = require('express');
const {
{{IMPORTS}}
} = require('{{IMPORT_FROM}}');
{{EXTRA_REQUIRES}}
{{SETUP}}
function before(app) {
{{BEFORE_MW}}
}

function afterBodyParse(app) {
{{AFTER_BODY_PARSE_MW}}
}

function routes(app) {
{{ROUTES}}
}

function after(app) {
{{AFTER_MW}}
}

module.exports = { before, afterBodyParse, routes, after{{EXTRA_EXPORTS}} };
