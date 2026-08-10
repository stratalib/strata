import { sendPaymentFailureNotification } from '../services/email.js';

export async function handlePaymentFailure(paymentIntent) {
  try {
    const { orderId, customerEmail, customerName } = paymentIntent.metadata;
    const lastError = paymentIntent.last_payment_error;

    const errorMessage = lastError
      ? `Payment failed: ${lastError.message}`
      : 'Payment failed for unknown reason';

    await sendPaymentFailureNotification({
      email: customerEmail,
      name: customerName,
      orderId,
      errorMessage,
    });

    console.log(`Payment failure notification sent for order ${orderId}`);
  } catch (error) {
    console.error('Error handling payment failure:', error);
    throw error;
  }
}
