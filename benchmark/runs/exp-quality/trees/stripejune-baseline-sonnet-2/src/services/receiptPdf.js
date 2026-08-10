const PDFDocument = require('pdfkit');
const { env } = require('../config/env');
const { formatMoney } = require('../utils/formatMoney');

// PDFKit is a write stream, not a function that returns a buffer -- generation
// is inherently async even though there's no I/O, because we have to wait for
// the 'end' event after all draw calls finish.
function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text(env.company.name, { align: 'left' });
    if (env.company.address) {
      doc.fontSize(10).fillColor('#555').text(env.company.address);
    }
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('Receipt', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10);
    doc.text(`Receipt #: ${order.objectId}`);
    doc.text(`Date: ${new Date(order.createdAt).toLocaleString('en-US')}`);
    doc.text(`Billed to: ${order.customerName || order.customerEmail}`);
    doc.text(`Email: ${order.customerEmail}`);
    doc.moveDown(1);

    const tableTop = doc.y;
    const col = { desc: 50, qty: 350, amount: 420 };

    doc.font('Helvetica-Bold');
    doc.text('Description', col.desc, tableTop);
    doc.text('Qty', col.qty, tableTop);
    doc.text('Amount', col.amount, tableTop);
    doc.font('Helvetica');
    doc.moveDown(0.5);
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor('#ccc')
      .stroke();
    doc.moveDown(0.5);

    const items = order.lineItems.length
      ? order.lineItems
      : [{ description: 'Payment', quantity: 1, amount: order.amountTotal }];

    for (const item of items) {
      const rowY = doc.y;
      doc.text(item.description || 'Item', col.desc, rowY, { width: 280 });
      doc.text(String(item.quantity ?? 1), col.qty, rowY);
      doc.text(formatMoney(item.amount, order.currency), col.amount, rowY);
      doc.moveDown(0.75);
    }

    doc.moveDown(0.5);
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor('#ccc')
      .stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').text(`Total: ${formatMoney(order.amountTotal, order.currency)}`, col.amount, doc.y);
    doc.font('Helvetica');

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888').text('Thank you for your business.', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
