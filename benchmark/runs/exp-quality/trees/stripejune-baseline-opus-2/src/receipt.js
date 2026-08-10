'use strict';

const PDFDocument = require('pdfkit');
const { config } = require('./config');
const { formatAmount } = require('./mailer');

// Build a PDF receipt for an order and resolve with a Buffer. PDFKit writes to
// a stream; we buffer the chunks and resolve once the document is finalised.
function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = order.currency || 'usd';

    // Header
    doc.fontSize(20).text(config.company.name, { continued: false });
    doc.fontSize(10).fillColor('#555555').text(config.company.address);
    doc.text(`Support: ${config.company.supportEmail}`);
    doc.moveDown();

    doc.fillColor('#000000').fontSize(16).text('Receipt');
    doc.moveDown(0.5);

    // Meta block
    doc.fontSize(10);
    const issued = order.paidAt ? new Date(order.paidAt) : new Date();
    doc.text(`Order reference: ${order.orderId}`);
    doc.text(`Date: ${issued.toISOString().slice(0, 10)}`);
    if (order.customerName) doc.text(`Billed to: ${order.customerName}`);
    doc.text(`Email: ${order.customerEmail}`);
    if (order.paymentIntentId) doc.text(`Payment ID: ${order.paymentIntentId}`);
    doc.moveDown();

    // Line items table
    const items =
      Array.isArray(order.items) && order.items.length > 0
        ? order.items
        : [
            {
              description: order.description || 'Purchase',
              quantity: 1,
              amount: order.amountTotal,
            },
          ];

    const tableTop = doc.y;
    const colDescX = 50;
    const colQtyX = 330;
    const colAmountX = 420;

    doc.font('Helvetica-Bold');
    doc.text('Description', colDescX, tableTop);
    doc.text('Qty', colQtyX, tableTop);
    doc.text('Amount', colAmountX, tableTop, { width: 90, align: 'right' });
    doc.font('Helvetica');
    doc
      .moveTo(colDescX, doc.y + 2)
      .lineTo(545, doc.y + 2)
      .strokeColor('#cccccc')
      .stroke();
    doc.moveDown(0.5);

    for (const item of items) {
      const y = doc.y;
      const qty = item.quantity || 1;
      // Per-item amount is stored in minor units, like the total.
      const lineAmount = item.amount != null ? item.amount : 0;
      doc.text(String(item.description || 'Item'), colDescX, y, { width: 270 });
      doc.text(String(qty), colQtyX, y);
      doc.text(formatAmount(lineAmount, currency), colAmountX, y, { width: 90, align: 'right' });
      doc.moveDown(0.5);
    }

    // Total
    doc
      .moveTo(colDescX, doc.y + 2)
      .lineTo(545, doc.y + 2)
      .strokeColor('#cccccc')
      .stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold');
    doc.text('Total', colQtyX, doc.y);
    doc.text(formatAmount(order.amountTotal, currency), colAmountX, doc.y - doc.currentLineHeight(), {
      width: 90,
      align: 'right',
    });
    doc.font('Helvetica');

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#777777').text('Thank you for your business.', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
