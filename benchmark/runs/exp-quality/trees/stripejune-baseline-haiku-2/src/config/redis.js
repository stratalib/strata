import { createClient } from 'redis';
import { config } from './env.js';

let client;

export async function getRedisClient() {
  if (client) {
    return client;
  }

  client = createClient({ url: config.redis.url });

  client.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await client.connect();
  return client;
}

export async function closeRedis() {
  if (client) {
    await client.quit();
  }
}
