import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

test('Integration: Payment workflow', async (t) => {
  await t.test('should have all required components', async () => {
    const { stripe } = await import('../src/config/stripe.js');
    const { getMailer } = await import('../src/config/mailer.js');
    const { generateReceiptPDF } = await import('../src/services/receiptService.js');
    const { sendPurchaseConfirmation, sendReceiptPDF } = await import('../src/services/emailService.js');
    const { enqueueReceiptJob, createReceiptQueue } = await import('../src/jobs/receiptJob.js');

    assert(stripe, 'Stripe client should exist');
    assert(typeof getMailer === 'function', 'Mailer factory should exist');
    assert(typeof generateReceiptPDF === 'function', 'PDF generation should exist');
    assert(typeof sendPurchaseConfirmation === 'function', 'Confirmation email should exist');
    assert(typeof sendReceiptPDF === 'function', 'Receipt email should exist');
    assert(typeof enqueueReceiptJob === 'function', 'Job enqueueing should exist');
    assert(typeof createReceiptQueue === 'function', 'Queue creation should exist');
  });

  await t.test('should handle payment data structure', async () => {
    const paymentData = {
      paymentId: 'pi_1234567890',
      amount: 2999,
      status: 'succeeded',
      paymentMethod: 'card_visa',
      description: 'Test purchase',
      customerEmail: 'user@example.com',
      timestamp: new Date().toISOString(),
    };

    assert(paymentData.paymentId, 'Should have payment ID');
    assert(paymentData.amount > 0, 'Should have positive amount');
    assert(paymentData.status === 'succeeded', 'Should indicate success');
    assert(paymentData.customerEmail.includes('@'), 'Should have valid email');
  });

  await t.test('should generate PDF from payment data', async () => {
    const { generateReceiptPDF } = await import('../src/services/receiptService.js');

    const paymentData = {
      paymentId: 'pi_test_integration',
      amount: 5000,
      customerEmail: 'test@example.com',
      status: 'succeeded',
      paymentMethod: 'card',
      description: 'Integration test payment',
      timestamp: new Date().toISOString(),
    };

    const pdf = await generateReceiptPDF(paymentData);
    assert(Buffer.isBuffer(pdf), 'Should return buffer');
    assert(pdf.length > 0, 'PDF should not be empty');
    assert(pdf.toString('ascii', 0, 4) === '%PDF', 'Should be valid PDF');
  });

  await t.test('should validate Stripe webhook signature', async () => {
    const { stripe } = await import('../src/config/stripe.js');
    const secret = 'whsec_test_secret';
    const event = { type: 'payment_intent.succeeded', data: { object: { id: 'pi_test' } } };
    const payload = JSON.stringify(event);

    const timestamp = Math.floor(Date.now() / 1000);
    const sig = `t=${timestamp},v1=${crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex')}`;

    try {
      const verified = stripe.webhooks.constructEvent(payload, sig, secret);
      assert.equal(verified.type, 'payment_intent.succeeded');
    } catch (error) {
      assert.fail(`Valid signature should not throw: ${error.message}`);
    }
  });
});
