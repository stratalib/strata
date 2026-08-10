const PDFDocument = require('pdfkit');
const { config } = require('../lib/config');
const { formatAmount } = require('./emailService');

// Renders a receipt PDF into memory and resolves with the Buffer.
function generateReceiptPdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text(config.company.name, { align: 'left' });
    doc.fontSize(10).fillColor('#555').text(config.company.address);
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('Receipt', { align: 'left' });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');
    doc.text(`Order ID: ${order.id}`);
    doc.text(`Date: ${new Date(order.createdAt || Date.now()).toLocaleString('en-US')}`);
    doc.text(`Billed to: ${order.customerEmail}`);
    doc.moveDown(1);

    const tableTop = doc.y;
    const col = { desc: 50, qty: 320, unit: 390, total: 470 };

    doc.font('Helvetica-Bold');
    doc.text('Description', col.desc, tableTop);
    doc.text('Qty', col.qty, tableTop);
    doc.text('Unit', col.unit, tableTop);
    doc.text('Total', col.total, tableTop);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica');

    const items = order.items && order.items.length
      ? order.items
      : [{ description: order.productName || 'Purchase', quantity: 1, unitAmount: order.amountTotal }];

    for (const item of items) {
      const rowY = doc.y;
      const lineTotal = item.unitAmount * item.quantity;
      doc.text(item.description, col.desc, rowY, { width: col.qty - col.desc - 10 });
      doc.text(String(item.quantity), col.qty, rowY);
      doc.text(formatAmount(item.unitAmount, order.currency), col.unit, rowY);
      doc.text(formatAmount(lineTotal, order.currency), col.total, rowY);
      doc.moveDown(0.75);
    }

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').text(`Total: ${formatAmount(order.amountTotal, order.currency)}`, col.total - 80, doc.y, {
      width: 165,
      align: 'right',
    });

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9).fillColor('#777').text(
      `Questions about this receipt? Contact ${config.company.supportEmail}`,
      { align: 'left' }
    );

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
