'use strict';

function createPurchaseHandler(opts) {
  const { receiptQueue, mailer } = opts;

  return async (event) => {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Send purchase confirmation email immediately
      await mailer.send({
        to: session.customer_email || session.customer_details?.email,
        subject: 'Purchase Confirmation',
        text: `Thank you for your purchase! Order ID: ${session.id}`,
        html: `<p>Thank you for your purchase!</p><p>Order ID: <strong>${session.id}</strong></p><p>Your receipt will arrive shortly.</p>`,
      });

      // Queue receipt generation asynchronously
      await receiptQueue.addReceipt(
        session.id,
        session.customer_email || session.customer_details?.email,
        session.amount_total,
        session.metadata?.description || null
      );

      console.log(`[purchase] order ${session.id} confirmed and receipt queued`);
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      console.log(`[purchase] refund processed for ${charge.id}`);
    }
  };
}

module.exports = { createPurchaseHandler };
