'use strict';

const PDFDocument = require('pdfkit');
const { config } = require('./config');
const { formatMoney } = require('./mailer');

// PDFKit emits a PDF as a readable stream. We collect the chunks into one
// Buffer and resolve it, so callers get the finished bytes to attach to email.
function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).text(config.merchant.name, { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666').text('Payment Receipt');
    doc.fillColor('#000');
    doc.moveDown(1);

    // Order meta
    const paidAt = order.paidAt ? new Date(order.paidAt) : new Date();
    doc.fontSize(11);
    doc.text(`Receipt for order: ${order.id}`);
    doc.text(`Date: ${paidAt.toISOString().slice(0, 10)}`);
    if (order.paymentIntentId) {
      doc.text(`Payment reference: ${order.paymentIntentId}`);
    }
    doc.moveDown(1);

    // Bill-to
    doc.fontSize(12).text('Billed to', { underline: true });
    doc.fontSize(11);
    if (order.customerName) doc.text(order.customerName);
    doc.text(order.customerEmail);
    doc.moveDown(1);

    // Line items. Stripe line items may be absent (e.g. a bare PaymentIntent),
    // so fall back to a single summary line for the total.
    doc.fontSize(12).text('Items', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11);

    const items = Array.isArray(order.lineItems) && order.lineItems.length
      ? order.lineItems
      : [{ description: 'Purchase', quantity: 1, amount: order.amountTotal }];

    for (const item of items) {
      const qty = item.quantity || 1;
      const line = `${qty} x ${item.description || 'Item'}`;
      const amount = formatMoney(item.amount, order.currency);
      // Print description on the left, amount right-aligned on the same row.
      const y = doc.y;
      doc.text(line, 50, y);
      doc.text(amount, 50, y, { align: 'right' });
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);

    // Total
    const totalY = doc.y;
    doc.fontSize(13).text('Total paid', 50, totalY);
    doc.fontSize(13).text(
      formatMoney(order.amountTotal, order.currency),
      50,
      totalY,
      { align: 'right' }
    );

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666').text(
      `Thank you for your purchase. Questions? ${config.merchant.supportEmail}`,
      { align: 'center' }
    );

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
