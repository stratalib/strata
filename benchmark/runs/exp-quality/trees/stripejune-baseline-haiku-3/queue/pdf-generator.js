import PDFDocument from 'pdfkit';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatCurrency, formatDate } from '../utils/formatters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ensureReceiptDir() {
  const receiptDir = process.env.PDF_RECEIPT_DIR || './receipts';
  try {
    await fs.access(receiptDir);
  } catch {
    await fs.mkdir(receiptDir, { recursive: true });
  }
  return receiptDir;
}

export async function generateReceiptPDF(order) {
  const receiptDir = await ensureReceiptDir();
  const filename = `receipt-${order.id}-${Date.now()}.pdf`;
  const filepath = path.join(receiptDir, filename);

  const doc = new PDFDocument({
    bufferPages: true,
    margin: 50,
  });

  const stream = fs.createWriteStream(filepath);
  doc.pipe(stream);

  // Header
  doc.fontSize(24).font('Helvetica-Bold').text('RECEIPT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica').text('Payment Processor Inc.', { align: 'center' });
  doc.fontSize(10).fillColor('#888').text('paymentprocessor@local', { align: 'center' });
  doc.moveDown(1);

  // Horizontal line
  doc.strokeColor('#ddd').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  // Customer and Order Info
  doc.fontSize(11).fillColor('#000').font('Helvetica-Bold').text('Customer Information');
  doc.fontSize(10).font('Helvetica');
  doc.text(`Name: ${order.customerName}`);
  doc.text(`Email: ${order.customerEmail}`);
  doc.moveDown(0.5);

  doc.fontSize(11).font('Helvetica-Bold').text('Order Information');
  doc.fontSize(10).font('Helvetica');
  doc.text(`Order ID: ${order.id}`);
  doc.text(`Payment ID: ${order.paymentIntentId}`);
  doc.text(`Date: ${formatDate(order.paidAt)}`);
  doc.moveDown(1);

  // Line items table
  const tableTop = doc.y;
  const col1 = 50;
  const col2 = 300;
  const col3 = 420;
  const col4 = 510;

  doc.fontSize(10).font('Helvetica-Bold').text('Items', col1, tableTop);
  doc.text('Quantity', col3, tableTop);
  doc.text('Price', col4, tableTop, { align: 'right' });

  doc.strokeColor('#ddd').lineWidth(0.5).moveTo(col1, tableTop + 15).lineTo(545, tableTop + 15).stroke();

  let y = tableTop + 30;
  for (const item of order.items) {
    doc.fontSize(9).font('Helvetica').fillColor('#000');

    const description = item.description || 'Item';
    const lines = doc.heightOfString(description, { width: col2 - col1 - 10 });

    doc.text(description, col1, y, { width: col2 - col1 - 10 });
    doc.text(item.quantity.toString(), col3, y, { align: 'center' });
    doc.text(formatCurrency(item.price * item.quantity, order.currency), col4, y, { align: 'right' });

    y += Math.max(lines + 5, 20);
  }

  // Totals
  doc.strokeColor('#ddd').lineWidth(0.5).moveTo(col1, y).lineTo(545, y).stroke();
  y += 15;

  doc.fontSize(11).font('Helvetica-Bold');
  doc.text('Total:', col3, y);
  doc.text(formatCurrency(order.amount, order.currency), col4, y, { align: 'right' });

  doc.moveDown(2);
  doc.fontSize(9).fillColor('#888').font('Helvetica').text('Thank you for your purchase!', { align: 'center' });

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log(`PDF generated: ${filepath}`);
      resolve(filepath);
    });
    stream.on('error', reject);
    doc.end();
  });
}
