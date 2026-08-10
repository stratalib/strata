import express from 'express';
import { sendPurchaseConfirmation } from '../services/emailService.js';
import { enqueueReceiptJob } from '../jobs/receiptJob.js';

const router = express.Router();

router.post('/stripe', async (req, res) => {
  const event = req.stripeEvent;

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;

        const paymentData = {
          paymentId: paymentIntent.id,
          amount: paymentIntent.amount,
          status: paymentIntent.status,
          paymentMethod: paymentIntent.payment_method || 'Unknown',
          description: paymentIntent.description || '',
          timestamp: new Date().toISOString(),
        };

        const customerEmail = paymentIntent.receipt_email || paymentIntent.billing_details?.email;

        if (customerEmail) {
          await sendPurchaseConfirmation(customerEmail, paymentData);

          await enqueueReceiptJob({
            ...paymentData,
            customerEmail,
          });
        }

        console.log(`Payment succeeded: ${paymentIntent.id}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object;
        console.warn(`Payment failed: ${paymentIntent.id}`);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        console.log(`Charge refunded: ${charge.id}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
