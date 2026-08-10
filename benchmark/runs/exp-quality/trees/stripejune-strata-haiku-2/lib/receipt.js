'use strict';
const PDFDocument = require('pdfkit');

async function generateReceipt(receiptData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').text('Receipt', 50, 50);
    doc.fontSize(10).font('Helvetica').text(`Order ID: ${receiptData.orderId}`, 50, 80);
    doc.text(`Date: ${receiptData.date}`, 50, 100);
    doc.text(`Email: ${receiptData.email}`, 50, 120);

    doc.fontSize(12).font('Helvetica-Bold').text('Items', 50, 160);
    let yPos = 190;
    receiptData.items.forEach((item) => {
      doc.fontSize(10).font('Helvetica')
        .text(`${item.description}: $${(item.amount / 100).toFixed(2)}`, 50, yPos);
      yPos += 25;
    });

    doc.fontSize(12).font('Helvetica-Bold').text('Total', 50, yPos);
    doc.text(`$${(receiptData.totalAmount / 100).toFixed(2)}`, 150, yPos);

    doc.end();
  });
}

module.exports = { generateReceipt };
