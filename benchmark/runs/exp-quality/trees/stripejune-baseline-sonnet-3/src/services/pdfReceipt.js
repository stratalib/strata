const PDFDocument = require('pdfkit');
const { env } = require('../config/env');
const { formatAmount } = require('./emailTemplates');

// PDFKit writes to a stream; we buffer it in memory since receipts are small
// and we need the whole file before attaching it to an email.
function generateReceiptPdf({ orderId, customerName, customerEmail, amount, currency, paidAt, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const paidAtDate = paidAt ? new Date(paidAt) : new Date();

    doc
      .fontSize(20)
      .text(env.companyName, { continued: false })
      .fontSize(10)
      .fillColor('#555555')
      .text('Payment Receipt')
      .moveDown(1.5);

    doc.fillColor('#000000').fontSize(12);
    doc.text(`Receipt for: ${customerName || customerEmail || 'Customer'}`);
    if (customerEmail) {
      doc.text(`Email: ${customerEmail}`);
    }
    doc.text(`Order reference: ${orderId}`);
    doc.text(`Date: ${paidAtDate.toISOString().slice(0, 10)}`);
    doc.moveDown(1);

    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor('#dddddd')
      .stroke();
    doc.moveDown(0.5);

    const tableItems = items && items.length > 0
      ? items
      : [{ description: 'Purchase', amount }];

    doc.fontSize(11);
    for (const item of tableItems) {
      const lineAmount = formatAmount(item.amount, currency);
      const description = item.description || 'Item';
      const y = doc.y;
      doc.text(description, 50, y, { width: 400 });
      doc.text(lineAmount, 450, y, { width: 95, align: 'right' });
      doc.moveDown(0.5);
    }

    doc.moveDown(0.5);
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor('#dddddd')
      .stroke();
    doc.moveDown(0.5);

    doc.fontSize(13).font('Helvetica-Bold');
    const totalY = doc.y;
    doc.text('Total', 50, totalY);
    doc.text(formatAmount(amount, currency), 450, totalY, { width: 95, align: 'right' });
    doc.font('Helvetica');

    doc.moveDown(3);
    doc
      .fontSize(9)
      .fillColor('#888888')
      .text(`Questions about this receipt? Contact ${env.supportEmail}.`, { align: 'left' });

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
