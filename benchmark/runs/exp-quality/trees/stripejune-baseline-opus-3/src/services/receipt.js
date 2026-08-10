'use strict';

const PDFDocument = require('pdfkit');
const config = require('../config');
const { formatAmount } = require('./mailer');

/**
 * Renders a payment receipt PDF and resolves to a Buffer.
 *
 * PDFKit is stream-based: you write to the document and it emits chunks. We
 * collect the chunks and resolve once the stream ends, because a Buffer is far
 * easier to attach to an email and to assert on in tests than a live stream.
 */
function generateReceiptPdf({
  orderId,
  amount,
  currency,
  customerName,
  customerEmail,
  paidAt,
  lineItems = [],
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const paidDate = paidAt ? new Date(paidAt) : new Date();

    // Header — company block
    doc.fontSize(20).text(config.company.name, { align: 'left' });
    doc.fontSize(10).fillColor('#555')
      .text(config.company.address)
      .text(config.company.supportEmail);
    doc.moveDown();

    // Title
    doc.fillColor('#000').fontSize(16).text('Receipt', { align: 'right' });
    doc.fontSize(10).fillColor('#555')
      .text(`Order: ${orderId}`, { align: 'right' })
      .text(`Date: ${paidDate.toISOString().slice(0, 10)}`, { align: 'right' });
    doc.moveDown(2);

    // Billed-to block
    doc.fillColor('#000').fontSize(12).text('Billed to');
    doc.fontSize(10).fillColor('#333')
      .text(customerName || '—')
      .text(customerEmail || '—');
    doc.moveDown(1.5);

    // Line items table (falls back to a single summary row if none provided)
    const items = lineItems.length
      ? lineItems
      : [{ description: 'Purchase', amount, currency }];

    drawTableHeader(doc);
    let total = 0;
    for (const item of items) {
      const itemAmount = typeof item.amount === 'number' ? item.amount : amount;
      total += itemAmount;
      drawTableRow(doc, item.description || 'Item', formatAmount(itemAmount, item.currency || currency));
    }

    // Total row
    doc.moveDown(0.5);
    const y = doc.y;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#000')
      .text('Total', 50, doc.y, { continued: true })
      .text(formatAmount(total, currency), { align: 'right' });

    // Footer
    doc.moveDown(4);
    doc.fontSize(9).fillColor('#777')
      .text('Thank you for your business.', { align: 'center' })
      .text(`This receipt was generated automatically for order ${orderId}.`, { align: 'center' });

    doc.end();
  });
}

function drawTableHeader(doc) {
  doc.fontSize(10).fillColor('#000');
  const y = doc.y;
  doc.text('Description', 50, y, { continued: true });
  doc.text('Amount', { align: 'right' });
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor('#000').stroke();
  doc.moveDown(0.5);
}

function drawTableRow(doc, description, amountText) {
  doc.fontSize(10).fillColor('#333');
  const y = doc.y;
  doc.text(description, 50, y, { continued: true });
  doc.text(amountText, { align: 'right' });
  doc.moveDown(0.25);
}

module.exports = { generateReceiptPdf };
