import { getOrderStore } from '../storage/order-store.js';
import { sendPurchaseConfirmation } from '../services/email.js';
import { queueReceiptGeneration } from '../queue/receipt-queue.js';

export async function handlePaymentSuccess(paymentIntent) {
  const orderStore = getOrderStore();

  try {
    // Retrieve order metadata from payment intent
    const { orderId, customerEmail, customerName, amount, currency, items } = paymentIntent.metadata;

    // Store order record
    const order = {
      id: orderId,
      paymentIntentId: paymentIntent.id,
      chargeId: paymentIntent.charges.data[0]?.id,
      customerEmail,
      customerName,
      amount: parseInt(amount),
      currency,
      items: JSON.parse(items),
      status: 'paid',
      paidAt: new Date(paymentIntent.created * 1000).toISOString(),
      receiptUrl: null,
    };

    await orderStore.save(order);
    console.log(`Order ${orderId} saved to storage`);

    // Send immediate purchase confirmation email
    await sendPurchaseConfirmation({
      email: customerEmail,
      name: customerName,
      orderId,
      amount: order.amount,
      currency,
      items: order.items,
    });

    // Queue background job for PDF receipt generation and email
    await queueReceiptGeneration(order);
    console.log(`Receipt generation queued for order ${orderId}`);
  } catch (error) {
    console.error('Error handling payment success:', error);
    throw error;
  }
}
