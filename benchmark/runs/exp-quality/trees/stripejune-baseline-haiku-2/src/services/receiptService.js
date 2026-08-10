import PDFDocument from 'pdfkit';
import { Readable } from 'stream';

export function generateReceiptPDF(paymentData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Receipt', { align: 'center' }).moveDown();
    doc.fontSize(12);

    doc.text(`Payment ID: ${paymentData.paymentId}`).moveDown(0.5);
    doc.text(`Date: ${new Date(paymentData.timestamp).toLocaleString()}`).moveDown(0.5);
    doc.text(`Customer: ${paymentData.customerEmail}`).moveDown(0.5);
    doc.text(`Amount: $${(paymentData.amount / 100).toFixed(2)}`).moveDown(1);

    doc.fontSize(11).text('Payment Details', { underline: true }).moveDown(0.5);
    doc.text(`Status: ${paymentData.status}`).moveDown(0.5);
    doc.text(`Payment Method: ${paymentData.paymentMethod}`).moveDown(1);

    if (paymentData.description) {
      doc.fontSize(11).text('Description', { underline: true }).moveDown(0.5);
      doc.fontSize(10).text(paymentData.description).moveDown(1);
    }

    doc.fontSize(9).text('Thank you for your purchase!', { align: 'center' });
    doc.end();
  });
}
