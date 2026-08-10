'use strict';

const { generateReceiptPdf } = require('../services/receipt');
const { sendReceiptEmail } = require('../services/mailer');
const logger = require('../lib/logger');

/**
 * The actual work a receipt job does: render the PDF, then email it.
 * Extracted from the Worker wiring so it can be unit-tested directly with a
 * plain data object, no Redis required.
 *
 * Throwing here is intentional — BullMQ catches the throw and retries per the
 * queue's backoff policy. So a transient SMTP failure just retries; it does not
 * silently drop the receipt.
 */
async function processReceiptJob(data) {
  const { orderId, amount, currency, customerName, customerEmail, paidAt, lineItems } = data;

  logger.info('processing receipt job', { orderId });

  const pdfBuffer = await generateReceiptPdf({
    orderId,
    amount,
    currency,
    customerName,
    customerEmail,
    paidAt,
    lineItems,
  });

  await sendReceiptEmail({
    to: customerEmail,
    orderId,
    amount,
    currency,
    customerName,
    pdfBuffer,
  });

  logger.info('receipt job complete', { orderId, pdfBytes: pdfBuffer.length });
  return { orderId, pdfBytes: pdfBuffer.length };
}

module.exports = { processReceiptJob };
