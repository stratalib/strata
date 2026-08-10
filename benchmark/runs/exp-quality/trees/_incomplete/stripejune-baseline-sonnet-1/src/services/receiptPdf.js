const PDFDocument = require('pdfkit');
const { config } = require('../config/env');
const { formatAmount } = require('./mailer');

function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const amount = formatAmount(order.amount_total, order.currency);
    const issuedAt = new Date(order.created_at + 'Z');

    doc.fontSize(20).text(config.appName, { continued: false });
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor('#555').text('Payment Receipt');
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(11);
    doc.text(`Receipt #: ${order.id}`);
    doc.text(`Date: ${issuedAt.toUTCString()}`);
    doc.text(`Customer: ${order.customer_name || order.customer_email}`);
    doc.text(`Email: ${order.customer_email}`);
    if (order.stripe_payment_intent_id) {
      doc.text(`Payment reference: ${order.stripe_payment_intent_id}`);
    }
    doc.moveDown(1.5);

    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Description', 50, tableTop);
    doc.text('Amount', 400, tableTop);
    doc.font('Helvetica');
    doc.moveTo(50, tableTop + 18).lineTo(550, tableTop + 18).strokeColor('#ccc').stroke();

    const rowY = tableTop + 28;
    doc.text(order.description || 'Purchase', 50, rowY, { width: 320 });
    doc.text(amount, 400, rowY);

    doc.moveTo(50, rowY + 24).lineTo(550, rowY + 24).strokeColor('#ccc').stroke();
    doc.font('Helvetica-Bold').text('Total', 50, rowY + 34);
    doc.text(amount, 400, rowY + 34);
    doc.font('Helvetica');

    doc.moveDown(4);
    doc.fontSize(9).fillColor('#888').text('This receipt was generated automatically. Please retain it for your records.', {
      width: 500,
    });

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
