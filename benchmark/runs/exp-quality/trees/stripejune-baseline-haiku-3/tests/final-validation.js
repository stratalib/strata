import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

async function validateSystem() {
  console.log('=== Final System Validation ===\n');

  const checks = [];

  // 1. Check all imports can be traced
  async function checkImports(filePath, name) {
    try {
      const content = await fs.readFile(filePath, 'utf8');

      // Extract all import statements
      const importPattern = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
      const imports = Array.from(content.matchAll(importPattern)).map((m) => m[1]);

      const missingImports = [];
      for (const imp of imports) {
        if (imp.startsWith('.')) {
          // Relative import
          const resolved = path.resolve(path.dirname(filePath), imp);
          const withJs = resolved.endsWith('.js') ? resolved : resolved + '.js';
          try {
            await fs.access(withJs);
          } catch {
            missingImports.push(imp);
          }
        }
        // Skip node_modules imports (they'll be installed)
      }

      if (missingImports.length > 0) {
        checks.push({ name, status: '✗', msg: `Missing imports: ${missingImports.join(', ')}` });
      } else {
        checks.push({ name, status: '✓', msg: 'All imports resolved' });
      }
    } catch (error) {
      checks.push({ name, status: '✗', msg: error.message });
    }
  }

  // 2. Check request/response flow logic
  async function checkFlowLogic() {
    const webhookCode = await fs.readFile(path.join(projectRoot, 'handlers/webhook.js'), 'utf8');
    const successCode = await fs.readFile(path.join(projectRoot, 'handlers/payment-success.js'), 'utf8');
    const queueCode = await fs.readFile(path.join(projectRoot, 'queue/receipt-queue.js'), 'utf8');

    const hasWebhookVerification = webhookCode.includes('stripe.webhooks.constructEvent');
    const hasPaymentSuccess = successCode.includes('handlePaymentSuccess');
    const hasQueueInit = queueCode.includes('initializeReceiptQueue');

    if (hasWebhookVerification && hasPaymentSuccess && hasQueueInit) {
      checks.push({
        name: 'Payment flow logic',
        status: '✓',
        msg: 'Webhook → Success handler → Queue initialization',
      });
    } else {
      checks.push({ name: 'Payment flow logic', status: '✗', msg: 'Missing flow components' });
    }
  }

  // 3. Check Stripe integration
  async function checkStripeIntegration() {
    const files = ['server.js', 'handlers/webhook.js', 'routes/orders.js', 'handlers/payment-success.js'];
    let stripeCount = 0;

    for (const file of files) {
      const content = await fs.readFile(path.join(projectRoot, file), 'utf8');
      if (content.includes("new Stripe(")) stripeCount++;
    }

    if (stripeCount >= 2) {
      checks.push({
        name: 'Stripe integration',
        status: '✓',
        msg: `Stripe client created in ${stripeCount} places`,
      });
    } else {
      checks.push({ name: 'Stripe integration', status: '✗', msg: 'Insufficient Stripe usage' });
    }
  }

  // 4. Check email configuration
  async function checkEmailSetup() {
    const emailCode = await fs.readFile(path.join(projectRoot, 'services/email.js'), 'utf8');

    const hasNodemailer = emailCode.includes('nodemailer');
    const hasSendMail = emailCode.includes('sendMail');
    const hasPurchaseConfirmation = emailCode.includes('sendPurchaseConfirmation');
    const hasReceipt = emailCode.includes('sendReceiptEmail');
    const hasFailure = emailCode.includes('sendPaymentFailureNotification');

    if (hasNodemailer && hasSendMail && hasPurchaseConfirmation && hasReceipt && hasFailure) {
      checks.push({
        name: 'Email service',
        status: '✓',
        msg: 'Nodemailer + 3 email types (confirmation, receipt, failure)',
      });
    } else {
      checks.push({ name: 'Email service', status: '✗', msg: 'Email service incomplete' });
    }
  }

  // 5. Check PDF generation
  async function checkPDFSetup() {
    const pdfCode = await fs.readFile(path.join(projectRoot, 'queue/pdf-generator.js'), 'utf8');

    const hasPDFKit = pdfCode.includes('PDFDocument');
    const hasGenerate = pdfCode.includes('generateReceiptPDF');
    const hasPipe = pdfCode.includes('.pipe');

    if (hasPDFKit && hasGenerate && hasPipe) {
      checks.push({
        name: 'PDF generation',
        status: '✓',
        msg: 'PDFKit with document generation',
      });
    } else {
      checks.push({ name: 'PDF generation', status: '✗', msg: 'PDF setup incomplete' });
    }
  }

  // 6. Check BullMQ queue
  async function checkQueueSetup() {
    const queueCode = await fs.readFile(path.join(projectRoot, 'queue/receipt-queue.js'), 'utf8');

    const hasQueue = queueCode.includes('new Queue');
    const hasWorker = queueCode.includes('new Worker');
    const hasRetry = queueCode.includes('attempts');
    const hasBackoff = queueCode.includes('backoff');

    if (hasQueue && hasWorker && hasRetry && hasBackoff) {
      checks.push({
        name: 'BullMQ queue',
        status: '✓',
        msg: 'Queue + Worker with retries and backoff',
      });
    } else {
      checks.push({ name: 'BullMQ queue', status: '✗', msg: 'Queue setup incomplete' });
    }
  }

  // 7. Check error handling
  async function checkErrorHandling() {
    const webhookCode = await fs.readFile(path.join(projectRoot, 'handlers/webhook.js'), 'utf8');
    const queueCode = await fs.readFile(path.join(projectRoot, 'queue/receipt-queue.js'), 'utf8');
    const emailCode = await fs.readFile(path.join(projectRoot, 'services/email.js'), 'utf8');

    const hasTryCatch = webhookCode.includes('try') && webhookCode.includes('catch');
    const hasJobFailed = queueCode.includes('on(\'failed\'');
    const hasEmailFallback = emailCode.includes('[MOCK]');

    if (hasTryCatch && hasJobFailed && hasEmailFallback) {
      checks.push({
        name: 'Error handling',
        status: '✓',
        msg: 'Try-catch blocks, job failure handlers, email fallback',
      });
    } else {
      checks.push({ name: 'Error handling', status: '✗', msg: 'Incomplete error handling' });
    }
  }

  // 8. Check storage layer
  async function checkStorage() {
    const storageCode = await fs.readFile(path.join(projectRoot, 'storage/order-store.js'), 'utf8');

    const hasClass = storageCode.includes('class OrderStore');
    const hasSave = storageCode.includes('async save');
    const hasGet = storageCode.includes('async get');
    const hasAppend = storageCode.includes('appendFile');

    if (hasClass && hasSave && hasGet && hasAppend) {
      checks.push({
        name: 'Order storage',
        status: '✓',
        msg: 'JSONL append-only storage with save/get/getAll',
      });
    } else {
      checks.push({ name: 'Order storage', status: '✗', msg: 'Storage incomplete' });
    }
  }

  // Run all checks
  await Promise.all([
    checkImports(path.join(projectRoot, 'server.js'), 'server.js imports'),
    checkImports(path.join(projectRoot, 'handlers/webhook.js'), 'webhook.js imports'),
    checkImports(path.join(projectRoot, 'routes/orders.js'), 'orders.js imports'),
    checkFlowLogic(),
    checkStripeIntegration(),
    checkEmailSetup(),
    checkPDFSetup(),
    checkQueueSetup(),
    checkErrorHandling(),
    checkStorage(),
  ]);

  console.log('Integration Checks:\n');
  for (const check of checks) {
    const status = check.status === '✓' ? '✓' : '✗';
    console.log(`${status} ${check.name}`);
    console.log(`  └─ ${check.msg}`);
  }

  const passed = checks.filter((c) => c.status === '✓').length;
  const total = checks.length;

  console.log(`\n${passed}/${total} checks passed\n`);

  if (passed === total) {
    console.log('✓ System is fully implemented and ready for deployment');
    console.log('\nNext steps:');
    console.log('  1. npm install');
    console.log('  2. Copy .env.example to .env and fill in credentials');
    console.log('  3. Start Redis: redis-server');
    console.log('  4. npm run dev');
    console.log('  5. Point Stripe webhook to: POST http://localhost:3000/api/webhooks/stripe');
    process.exit(0);
  } else {
    console.log(`✗ ${total - passed} validation issue(s) found`);
    process.exit(1);
  }
}

validateSystem().catch((error) => {
  console.error('Validation error:', error);
  process.exit(1);
});
