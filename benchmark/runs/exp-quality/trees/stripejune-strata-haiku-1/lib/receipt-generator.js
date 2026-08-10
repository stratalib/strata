'use strict';
const PDFDocument = require('pdfkit');

// Generate a PDF receipt buffer for a purchase.
function generateReceipt(data) {
  const { orderNumber, email, amount, currency, items, timestamp } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('RECEIPT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica').text(`Order #${orderNumber}`, { align: 'center' });
    doc.text(`Date: ${new Date(timestamp).toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(1);

    // Customer info
    doc.fontSize(10).font('Helvetica-Bold').text('CUSTOMER');
    doc.fontSize(10).font('Helvetica').text(email);
    doc.moveDown(1);

    // Items table header
    doc.fontSize(10).font('Helvetica-Bold');
    const col1 = 50;
    const col2 = 200;
    const col3 = 400;
    doc.text('Description', col1, doc.y);
    doc.text('Quantity', col2, doc.y);
    doc.text('Amount', col3, doc.y);
    doc.moveDown(0.5);

    // Horizontal line
    const lineY = doc.y;
    doc.strokeColor('#cccccc').moveTo(col1, lineY).lineTo(550, lineY).stroke();
    doc.moveDown(0.5);

    // Items
    doc.font('Helvetica').fontSize(10);
    let subtotal = 0;
    for (const item of items) {
      doc.text(item.name, col1, doc.y);
      doc.text(String(item.quantity), col2, doc.y);
      doc.text(`${currency.toUpperCase()} ${(item.amount / 100).toFixed(2)}`, col3, doc.y);
      doc.moveDown(0.5);
      subtotal += item.amount;
    }

    // Total
    doc.moveDown(0.5);
    doc.strokeColor('#cccccc').moveTo(col1, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text('TOTAL', col1, doc.y);
    doc.text(`${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`, col3, doc.y);
    doc.moveDown(1);

    // Footer
    doc.fontSize(9).font('Helvetica').fillColor('#666666');
    doc.text('Thank you for your purchase!', { align: 'center' });
    doc.text('This is an automated receipt. Please keep this for your records.', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateReceipt };
