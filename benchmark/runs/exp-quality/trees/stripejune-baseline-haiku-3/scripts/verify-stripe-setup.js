import { config } from 'dotenv';
import Stripe from 'stripe';

config();

async function verifySetup() {
  console.log('Verifying Stripe setup...\n');

  const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PUBLIC_KEY',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('✗ Missing environment variables:', missing.join(', '));
    console.error('  Copy .env.example to .env and fill in your credentials');
    process.exit(1);
  }

  console.log('✓ All required environment variables found\n');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const balance = await stripe.balance.retrieve();
    console.log('✓ Stripe API authentication successful');
    console.log(`  Available balance: ${JSON.stringify(balance.available)}\n`);
  } catch (error) {
    console.error('✗ Stripe API authentication failed:', error.message);
    process.exit(1);
  }

  const emailVars = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const missingEmail = emailVars.filter((key) => !process.env[key]);
  if (missingEmail.length > 0) {
    console.warn('⚠ Missing email configuration:', missingEmail.join(', '));
    console.warn('  Email features will not work until configured\n');
  } else {
    console.log('✓ Email configuration found\n');
  }

  const redisVars = ['REDIS_HOST', 'REDIS_PORT'];
  const defaultRedis = { REDIS_HOST: 'localhost', REDIS_PORT: '6379' };
  console.log(
    '✓ Redis configuration:',
    process.env.REDIS_HOST || defaultRedis.REDIS_HOST,
    ':',
    process.env.REDIS_PORT || defaultRedis.REDIS_PORT
  );
  console.log('  Make sure Redis is running before starting the server\n');

  console.log('Setup verification complete!');
  console.log('Next steps:');
  console.log('  1. npm install');
  console.log('  2. npm run dev');
  console.log('  3. (In another terminal) node examples/test-payment-flow.js');
}

verifySetup().catch((error) => {
  console.error('Verification error:', error);
  process.exit(1);
});
