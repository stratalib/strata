'use strict';
const PDFDocument = require('pdfkit');
const { formatMoney } = require('./purchase');
const env = require('../config/env');

/**
 * Renders a one-page PDF receipt into a Buffer. PDFKit is a stream writer, not a string builder,
 * so we collect its output chunks and resolve once the stream ends — there is no synchronous
 * "give me the bytes" API.
 *
 * @param {{orderId: string, email: string, customerName?: string, amount: number, currency: string,
 *   items?: Array<{description: string, amount: number}>|null, purchasedAt: string}} purchase
 * @returns {Promise<Buffer>}
 */
function renderReceiptPdf(purchase) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const purchasedAt = new Date(purchase.purchasedAt);

    doc.fontSize(20).text(env.company.name, { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#555').text('Payment Receipt');
    doc.fillColor('#000');
    doc.moveDown(1.5);

    doc.fontSize(11);
    doc.text(`Receipt for order: ${purchase.orderId}`);
    doc.text(`Date: ${purchasedAt.toUTCString()}`);
    if (purchase.customerName) doc.text(`Customer: ${purchase.customerName}`);
    doc.text(`Email: ${purchase.email}`);
    doc.moveDown(1.5);

    // Table header
    const tableTop = doc.y;
    const col1 = 50;
    const col2 = 420;
    doc.font('Helvetica-Bold');
    doc.text('Description', col1, tableTop);
    doc.text('Amount', col2, tableTop, { width: 100, align: 'right' });
    doc.font('Helvetica');
    doc.moveDown(0.5);
    doc.moveTo(col1, doc.y).lineTo(col1 + 470, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    const items = purchase.items && purchase.items.length
      ? purchase.items
      : [{ description: `Order ${purchase.orderId}`, amount: purchase.amount }];

    for (const item of items) {
      const rowY = doc.y;
      doc.text(item.description, col1, rowY, { width: 350 });
      doc.text(formatMoney(item.amount, purchase.currency), col2, rowY, { width: 100, align: 'right' });
      doc.moveDown(0.5);
    }

    doc.moveDown(0.5);
    doc.moveTo(col1, doc.y).lineTo(col1 + 470, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold');
    const totalRowY = doc.y;
    doc.text('Total', col1, totalRowY, { width: 350 });
    doc.text(formatMoney(purchase.amount, purchase.currency), col2, totalRowY, { width: 100, align: 'right' });
    doc.font('Helvetica');

    doc.moveDown(3);
    doc.fontSize(9).fillColor('#777').text(
      `Questions about this receipt? Contact ${env.company.supportEmail}.`,
      { align: 'left' },
    );

    doc.end();
  });
}

module.exports = { renderReceiptPdf };
