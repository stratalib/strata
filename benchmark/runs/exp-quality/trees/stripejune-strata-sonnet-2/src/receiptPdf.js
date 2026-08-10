'use strict';

const PDFDocument = require('pdfkit');

/**
 * @param {{
 *   receiptNumber: string,
 *   purchasedAt: Date,
 *   customerName?: string,
 *   customerEmail: string,
 *   currency: string,
 *   lineItems: Array<{ description: string, quantity: number, unitAmount: number }>,
 *   totalAmount: number,
 *   paymentMethodLabel?: string,
 * }} receipt
 * @returns {Promise<Buffer>}
 */
function generateReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fmt = (cents) => formatMoney(cents, receipt.currency);

    doc
      .fontSize(20)
      .text('Receipt', { align: 'left' })
      .moveDown(0.5);

    doc
      .fontSize(10)
      .fillColor('#555555')
      .text(`Receipt #${receipt.receiptNumber}`)
      .text(`Date: ${receipt.purchasedAt.toISOString().slice(0, 10)}`)
      .fillColor('#000000')
      .moveDown();

    doc
      .fontSize(11)
      .text('Billed to:')
      .fontSize(10)
      .text(receipt.customerName || receipt.customerEmail)
      .text(receipt.customerEmail)
      .moveDown();

    const tableTop = doc.y;
    const col = { desc: 50, qty: 330, unit: 390, total: 470 };

    doc.fontSize(10).fillColor('#555555');
    doc.text('Description', col.desc, tableTop);
    doc.text('Qty', col.qty, tableTop);
    doc.text('Unit', col.unit, tableTop);
    doc.text('Total', col.total, tableTop);
    doc
      .moveTo(50, tableTop + 15)
      .lineTo(545, tableTop + 15)
      .strokeColor('#cccccc')
      .stroke();

    let y = tableTop + 22;
    doc.fillColor('#000000');
    for (const item of receipt.lineItems) {
      const lineTotal = item.quantity * item.unitAmount;
      doc.fontSize(10);
      doc.text(item.description, col.desc, y, { width: col.qty - col.desc - 10 });
      doc.text(String(item.quantity), col.qty, y);
      doc.text(fmt(item.unitAmount), col.unit, y);
      doc.text(fmt(lineTotal), col.total, y);
      y += 20;
    }

    doc
      .moveTo(50, y + 5)
      .lineTo(545, y + 5)
      .strokeColor('#cccccc')
      .stroke();

    y += 15;
    doc.fontSize(12).text('Total', col.unit, y, { continued: false });
    doc.fontSize(12).text(fmt(receipt.totalAmount), col.total, y);

    if (receipt.paymentMethodLabel) {
      y += 30;
      doc
        .fontSize(9)
        .fillColor('#555555')
        .text(`Paid via ${receipt.paymentMethodLabel}`, col.desc, y);
    }

    doc
      .fontSize(8)
      .fillColor('#999999')
      .text('This receipt was generated automatically. Thank you for your purchase.', 50, 760, {
        width: 495,
        align: 'center',
      });

    doc.end();
  });
}

/** Stripe amounts are integer minor units (cents). Zero-decimal currencies (e.g. JPY) have none. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function formatMoney(minorUnits, currency) {
  const cur = String(currency || 'usd').toLowerCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);
  const amount = isZeroDecimal ? minorUnits : minorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${cur.toUpperCase()}`;
  }
}

module.exports = { generateReceiptPdf, formatMoney };
