#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: '.env.test' });

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;

async function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json: () => JSON.parse(data),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runIntegrationTests() {
  console.log('Running integration tests...\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Server is responsive
  console.log('Test 1: Server responds to health check');
  try {
    const res = await fetch(`${BASE_URL}/health`);
    assert.strictEqual(res.status, 200, 'Should return 200');
    const data = res.json();
    assert.strictEqual(data.ok, true, 'Should return ok: true');
    console.log('✓ Health check works\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 2: Webhook without signature is rejected
  console.log('Test 2: Webhook without signature is rejected');
  try {
    const res = await fetch(`${BASE_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert(res.status >= 400, `Should return error status, got ${res.status}`);
    console.log('✓ Unsigned webhook rejected\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 3: Webhook with invalid signature is rejected
  console.log('Test 3: Webhook with forged signature is rejected');
  try {
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const signature = 't=12345,v1=invalidsig';
    const res = await fetch(`${BASE_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
      },
      body: payload,
    });
    assert(res.status >= 400, `Should return error status, got ${res.status}`);
    console.log('✓ Forged signature rejected\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 4: Valid webhook is accepted
  console.log('Test 4: Valid signed webhook is accepted');
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      type: 'checkout.session.completed',
      created: timestamp,
      data: {
        object: {
          id: `cs_${crypto.randomBytes(8).toString('hex')}`,
          customer_email: 'test@example.com',
          amount_total: 9999,
          display_items: [],
        },
      },
    });

    const signedContent = `${timestamp}.${payload}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedContent)
      .digest('hex');

    const res = await fetch(`${BASE_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    });
    assert.strictEqual(res.status, 200, `Should return 200, got ${res.status}`);
    console.log('✓ Valid webhook accepted\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 5: Malformed JSON is handled gracefully
  console.log('Test 5: Malformed JSON returns error envelope');
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    // badJsonHandler returns 400 with JSON error
    assert(res.status === 400, `Should return 400, got ${res.status}`);
    const data = res.json();
    assert(data.error || data.message, 'Should have error field');
    console.log('✓ Malformed JSON handled gracefully\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Integration tests passed: ${passed}`);
  console.log(`Integration tests failed: ${failed}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// Wait for server to start
setTimeout(() => {
  runIntegrationTests().catch((err) => {
    console.error('Integration test error:', err);
    process.exit(1);
  });
}, 1000);
