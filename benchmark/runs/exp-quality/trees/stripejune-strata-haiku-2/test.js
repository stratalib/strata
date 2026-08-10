#!/usr/bin/env node
'use strict';
require('dotenv').config();

const http = require('http');
const { createTestStripeWebhook } = require('./lib/test-helpers');

async function testPaymentFlow() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';
  const baseUrl = `http://localhost:${process.env.PORT || 3000}`;

  console.log('Testing payment processing system...\n');

  // Test 1: Health check
  console.log('1. Testing health endpoint...');
  try {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json();
    if (data.ok) {
      console.log('✓ Health check passed\n');
    } else {
      console.log('✗ Health check failed\n');
      process.exit(1);
    }
  } catch (err) {
    console.log(`✗ Health check error: ${err.message}\n`);
    process.exit(1);
  }

  // Test 2: Invalid webhook (no signature)
  console.log('2. Testing webhook rejection without signature...');
  try {
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    if (res.status === 401) {
      console.log('✓ Correctly rejected unsigned webhook\n');
    } else {
      console.log(`✗ Expected 401, got ${res.status}\n`);
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}\n`);
  }

  // Test 3: Valid signed webhook
  console.log('3. Testing valid signed webhook...');
  try {
    const { payload, signature } = createTestStripeWebhook(secret);
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
      },
      body: payload,
    });
    if (res.status === 200) {
      console.log('✓ Webhook accepted and processed\n');
    } else {
      const text = await res.text();
      console.log(`✗ Expected 200, got ${res.status}: ${text}\n`);
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}\n`);
  }

  // Test 4: Replay protection
  console.log('4. Testing replay protection...');
  try {
    const { payload, signature } = createTestStripeWebhook(secret);
    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
      },
      body: payload,
    });
    if (res.status === 200) {
      const res2 = await fetch(`${baseUrl}/webhooks/stripe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signature,
        },
        body: payload,
      });
      if (res2.status === 409) {
        console.log('✓ Replay correctly rejected (409 Conflict)\n');
      } else {
        console.log(`✗ Expected 409 on replay, got ${res2.status}\n`);
      }
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}\n`);
  }

  console.log('All tests completed!');
  process.exit(0);
}

// Wait for server to be ready, then run tests
setTimeout(() => {
  testPaymentFlow().catch((err) => {
    console.error('Test error:', err);
    process.exit(1);
  });
}, 2000);
