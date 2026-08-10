import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

async function verifyCodeStructure() {
  console.log('Verifying code structure and patterns...\n');

  // Check all key files exist
  const requiredFiles = [
    'server.js',
    'package.json',
    '.env.example',
    'handlers/webhook.js',
    'handlers/payment-success.js',
    'handlers/payment-failure.js',
    'routes/orders.js',
    'services/email.js',
    'queue/receipt-queue.js',
    'queue/pdf-generator.js',
    'storage/order-store.js',
    'utils/formatters.js',
  ];

  console.log('✓ File Structure:');
  for (const file of requiredFiles) {
    const filepath = path.join(projectRoot, file);
    try {
      await fs.access(filepath);
      console.log(`  ✓ ${file}`);
    } catch {
      console.log(`  ✗ ${file} - MISSING`);
      process.exit(1);
    }
  }

  console.log('\n✓ Key Components Implemented:');

  // Verify webhook handler exists and has signature verification
  const webhookCode = await fs.readFile(path.join(projectRoot, 'handlers/webhook.js'), 'utf8');
  if (webhookCode.includes('stripe.webhooks.constructEvent')) {
    console.log('  ✓ Stripe webhook signature verification');
  } else {
    console.log('  ✗ Missing webhook signature verification');
    process.exit(1);
  }

  // Verify email service
  const emailCode = await fs.readFile(path.join(projectRoot, 'services/email.js'), 'utf8');
  if (emailCode.includes('nodemailer') && emailCode.includes('sendMail')) {
    console.log('  ✓ Email service with Nodemailer');
  } else {
    console.log('  ✗ Missing email service');
    process.exit(1);
  }

  // Verify BullMQ queue
  const queueCode = await fs.readFile(path.join(projectRoot, 'queue/receipt-queue.js'), 'utf8');
  if (queueCode.includes('Queue') && queueCode.includes('Worker')) {
    console.log('  ✓ BullMQ queue and worker');
  } else {
    console.log('  ✗ Missing BullMQ queue');
    process.exit(1);
  }

  // Verify PDF generation
  const pdfCode = await fs.readFile(path.join(projectRoot, 'queue/pdf-generator.js'), 'utf8');
  if (pdfCode.includes('PDFDocument') && pdfCode.includes('generateReceiptPDF')) {
    console.log('  ✓ PDFKit receipt generation');
  } else {
    console.log('  ✗ Missing PDF generation');
    process.exit(1);
  }

  // Verify order storage
  const storageCode = await fs.readFile(path.join(projectRoot, 'storage/order-store.js'), 'utf8');
  if (storageCode.includes('class OrderStore') && storageCode.includes('save') && storageCode.includes('get')) {
    console.log('  ✓ Order storage layer');
  } else {
    console.log('  ✗ Missing order storage');
    process.exit(1);
  }

  console.log('\n✓ Configuration & Scripts:');

  // Check .env.example
  const envExample = await fs.readFile(path.join(projectRoot, '.env.example'), 'utf8');
  const envVars = ['STRIPE_SECRET_KEY', 'SMTP_HOST', 'REDIS_HOST'];
  for (const envVar of envVars) {
    if (envExample.includes(envVar)) {
      console.log(`  ✓ ${envVar} configured`);
    }
  }

  // Check npm scripts
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  console.log('\n✓ npm Scripts Available:');
  for (const [name, script] of Object.entries(packageJson.scripts || {})) {
    console.log(`  ✓ npm run ${name}`);
  }

  console.log('\n✓ All verification checks passed');
  console.log('\nProject is ready for:');
  console.log('  1. npm install (to install dependencies)');
  console.log('  2. npm run dev (to start the server)');
  console.log('  3. node tests/test-suite.js (after npm install)');
}

verifyCodeStructure().catch((error) => {
  console.error('Verification error:', error);
  process.exit(1);
});
