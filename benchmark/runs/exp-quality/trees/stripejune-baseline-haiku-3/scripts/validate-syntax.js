import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const jsFiles = [
  'server.js',
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

async function validateSyntax() {
  console.log('Validating JavaScript syntax...\n');

  let allValid = true;

  for (const file of jsFiles) {
    const filepath = path.join(projectRoot, file);
    try {
      const content = await fs.readFile(filepath, 'utf8');

      // Basic checks
      const hasUnclosedBraces = (content.match(/\{/g) || []).length !== (content.match(/\}/g) || []).length;
      const hasUnclosedParens = (content.match(/\(/g) || []).length !== (content.match(/\)/g) || []).length;
      const hasUnclosedBrackets = (content.match(/\[/g) || []).length !== (content.match(/\]/g) || []).length;

      if (hasUnclosedBraces || hasUnclosedParens || hasUnclosedBrackets) {
        console.log(`✗ ${file} - Unbalanced braces/parens/brackets`);
        allValid = false;
      } else {
        console.log(`✓ ${file}`);
      }
    } catch (error) {
      console.log(`✗ ${file} - ${error.message}`);
      allValid = false;
    }
  }

  console.log();
  if (allValid) {
    console.log('✓ All files passed syntax validation');
    process.exit(0);
  } else {
    console.log('✗ Some files failed validation');
    process.exit(1);
  }
}

validateSyntax();
