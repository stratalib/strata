import PDFDocument from 'pdfkit';
import { Readable } from 'stream';

export async function generateReceiptPDF({
  paymentIntentId,
  amount,
  currency,
  timestamp,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('RECEIPT', { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    // Receipt details
    doc.fontSize(11).font('Helvetica');
    doc
      .text(`Payment ID: ${paymentIntentId}`, { width: 500 })
      .text(`Date: ${new Date(timestamp).toLocaleString()}`, { width: 500 });

    doc.moveDown(1);

    // Amount section
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .text(`Amount: ${getCurrencySymbol(currency)}${parseFloat(amount).toFixed(2)}`);

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    // Footer
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        'Thank you for your business. This receipt has been automatically generated.',
        {
          align: 'center',
          width: 500,
        }
      );

    doc.end();
  });
}

function getCurrencySymbol(currency) {
  const symbols = {
    usd: '$',
    eur: '€',
    gbp: '£',
    jpy: '¥',
  };
  return symbols[currency.toLowerCase()] || currency.toUpperCase();
}
