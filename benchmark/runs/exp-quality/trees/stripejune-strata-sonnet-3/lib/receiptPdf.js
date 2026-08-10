'use strict';
const PDFDocument = require('pdfkit');

/**
 * Render a receipt PDF into a Buffer.
 *
 * Buffered rather than streamed to a file: the caller (the worker) attaches the result directly to
 * an email, and never needs a file on disk at all. Returning a Promise<Buffer> keeps this composable
 * either way — write it to disk yourself if you want a copy, or hand the buffer straight to Nodemailer.
 *
 * @param {{
 *   receiptNumber: string,
 *   sessionId: string,
 *   customerEmail: string,
 *   customerName?: string,
 *   currency: string,
 *   amountTotal: number,   // minor units, e.g. cents — as Stripe reports it
 *   lineItems: Array<{ description: string, quantity: number, amountTotal: number }>,
 *   createdAt: Date,
 * }} data
 * @returns {Promise<Buffer>}
 */
function formatMoney(minorUnits, currency) {
  const amount = (Number(minorUnits) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
  }
}

function generateReceiptPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = data.currency || 'usd';
    const createdAt = data.createdAt instanceof Date ? data.createdAt : new Date(data.createdAt || Date.now());

    doc.fontSize(20).text('Receipt', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555555')
      .text(`Receipt #: ${data.receiptNumber}`)
      .text(`Date: ${createdAt.toISOString().slice(0, 10)}`)
      .text(`Order/Session ID: ${data.sessionId}`);
    doc.moveDown();

    doc.fillColor('#000000').fontSize(12).text('Billed to:', { underline: true });
    doc.fontSize(10);
    if (data.customerName) doc.text(data.customerName);
    doc.text(data.customerEmail || '');
    doc.moveDown();

    const tableTop = doc.y + 10;
    const col = { desc: 50, qty: 340, amount: 420 };
    doc.fontSize(10).fillColor('#000000');
    doc.text('Description', col.desc, tableTop, { bold: true });
    doc.text('Qty', col.qty, tableTop);
    doc.text('Amount', col.amount, tableTop);
    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor('#cccccc').stroke();

    let y = tableTop + 22;
    const items = Array.isArray(data.lineItems) && data.lineItems.length > 0
      ? data.lineItems
      : [{ description: 'Purchase', quantity: 1, amountTotal: data.amountTotal }];

    for (const item of items) {
      doc.text(String(item.description || 'Item'), col.desc, y, { width: 280 });
      doc.text(String(item.quantity != null ? item.quantity : 1), col.qty, y);
      doc.text(formatMoney(item.amountTotal, currency), col.amount, y);
      y += 20;
    }

    doc.moveTo(50, y + 5).lineTo(545, y + 5).strokeColor('#cccccc').stroke();
    y += 15;
    doc.fontSize(12).text('Total', col.qty, y);
    doc.fontSize(12).text(formatMoney(data.amountTotal, currency), col.amount, y);

    doc.moveDown(3);
    doc.fontSize(9).fillColor('#888888').text('Thank you for your purchase.', 50, doc.y, { align: 'center', width: 495 });

    doc.end();
  });
}

module.exports = { generateReceiptPdf, formatMoney };
