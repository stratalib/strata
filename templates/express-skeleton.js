'use strict';
require('dotenv').config();
const express = require('express');
const {
{{IMPORTS}}
} = require('{{IMPORT_FROM}}');
{{EXTRA_REQUIRES}}
{{SETUP}}
const app = express();

// TRUST PROXY — off by default, and that default is deliberate.
//
// Anything keyed on req.ip (rate limiting above all) is wrong behind a load balancer unless Express
// is told how many proxies to trust: req.ip becomes the PROXY's address, so every caller shares one
// bucket and the first burst 429s the entire internet. That is an outage, and it only appears in
// production.
//
// It is opt-in rather than automatic because the opposite mistake is worse: trusting
// X-Forwarded-For when nothing strips it lets any caller forge their own IP and bypass the limiter
// completely. Set TRUST_PROXY_HOPS to the number of proxies actually in front of this app —
// 1 behind a single nginx/ALB, 2 behind Cloudflare plus your own.
if (process.env.TRUST_PROXY_HOPS) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
}

{{MIDDLEWARE}}
{{ROUTES}}
{{HEALTH}}
{{ERROR_HANDLERS}}
const port = process.env.PORT || 3000;
{{LISTEN}}
