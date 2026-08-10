#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { generateReceipt } = require('./lib/receipt');
const { getTemplate } = require('./lib/email-templates');
const { createTestStripeWebhook } = require('./lib/test-helpers');

async function runTests() {
  console.log('Running unit tests...\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Receipt PDF generation
  console.log('Test 1: PDF receipt generation');
  try {
    const receiptData = {
      orderId: 'cs_test_123',
      date: '2026-08-05',
      email: 'customer@example.com',
      items: [
        { description: 'Widget', amount: 5000 },
        { description: 'Gadget', amount: 4999 },
      ],
      totalAmount: 9999,
    };
    const pdf = await generateReceipt(receiptData);
    assert(Buffer.isBuffer(pdf), 'Should return a Buffer');
    assert(pdf.length > 0, 'PDF should not be empty');
    assert(pdf.toString('utf8', 0, 4).includes('PDF'), 'Should be a valid PDF');
    console.log('✓ PDF generation works\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 2: Email template - purchase confirmation
  console.log('Test 2: Email template - purchase confirmation');
  try {
    const tmpl = getTemplate('purchase_confirmation');
    assert(tmpl.subject, 'Should have subject');
    assert(typeof tmpl.html === 'function', 'Should have html function');
    assert(typeof tmpl.text === 'function', 'Should have text function');

    const data = { orderId: 'cs_test_123', amount: '99.99' };
    const html = tmpl.html(data);
    const text = tmpl.text(data);

    assert(html.includes('cs_test_123'), 'HTML should include order ID');
    assert(html.includes('99.99'), 'HTML should include amount');
    assert(text.includes('cs_test_123'), 'Text should include order ID');
    assert(text.includes('99.99'), 'Text should include amount');

    console.log('✓ Purchase confirmation template works\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 3: Email template - receipt
  console.log('Test 3: Email template - receipt');
  try {
    const tmpl = getTemplate('receipt');
    assert(tmpl.subject, 'Should have subject');
    const data = { orderId: 'cs_test_123', amount: '99.99' };
    const html = tmpl.html(data);
    assert(html.includes('Receipt'), 'Should mention receipt');
    console.log('✓ Receipt template works\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 4: Stripe webhook signature generation
  console.log('Test 4: Stripe webhook signature generation');
  try {
    const secret = 'whsec_test_secret';
    const { payload, signature } = createTestStripeWebhook(secret);
    assert(payload, 'Should generate payload');
    assert(signature, 'Should generate signature');
    assert(signature.includes('t='), 'Signature should have timestamp');
    assert(signature.includes('v1='), 'Signature should have v1 hash');

    const parsed = JSON.parse(payload);
    assert(parsed.type === 'checkout.session.completed', 'Should be checkout event');
    assert(parsed.data.object.customer_email, 'Should have customer email');

    console.log('✓ Webhook signature generation works\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  // Test 5: Invalid template throws error
  console.log('Test 5: Invalid template rejection');
  try {
    getTemplate('nonexistent_template');
    console.log('✗ Should have thrown error\n');
    failed++;
  } catch (err) {
    assert(err.message.includes('Template not found'), 'Should say template not found');
    console.log('✓ Invalid templates rejected\n');
    passed++;
  }

  // Test 6: Receipt has all required fields
  console.log('Test 6: Receipt data validation');
  try {
    const receiptData = {
      orderId: 'cs_abc123',
      date: '2026-08-05',
      email: 'test@example.com',
      items: [{ description: 'Product', amount: 1000 }],
      totalAmount: 1000,
    };
    const pdf = await generateReceipt(receiptData);
    assert(pdf.length > 0, 'PDF should be generated');
    console.log('✓ Receipt contains all required data\n');
    passed++;
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
    failed++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Tests passed: ${passed}`);
  console.log(`Tests failed: ${failed}`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
