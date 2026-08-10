'use strict';
const crypto = require('crypto');

function createTestStripeWebhook(secret, eventType = 'checkout.session.completed') {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    type: eventType,
    created: timestamp,
    data: {
      object: {
        id: `cs_${crypto.randomBytes(8).toString('hex')}`,
        customer_email: 'customer@example.com',
        amount_total: 9999, // $99.99
        display_items: [
          {
            custom: { name: 'Test Product' },
            price_data: { unit_amount: 9999 },
          },
        ],
      },
    },
  });

  const signedContent = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest('hex');

  return {
    payload,
    signature: `t=${timestamp},v1=${signature}`,
  };
}

module.exports = { createTestStripeWebhook };
