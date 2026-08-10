import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(__dirname, 'orders.jsonl');

class OrderStore {
  async save(order) {
    try {
      const line = JSON.stringify(order) + '\n';
      await fs.appendFile(STORE_FILE, line);
    } catch (error) {
      console.error('Error saving order:', error);
      throw error;
    }
  }

  async get(orderId) {
    try {
      const content = await fs.readFile(STORE_FILE, 'utf8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines.reverse()) {
        const order = JSON.parse(line);
        if (order.id === orderId) {
          return order;
        }
      }
      return null;
    } catch (error) {
      console.error('Error reading order:', error);
      throw error;
    }
  }

  async getAll() {
    try {
      const content = await fs.readFile(STORE_FILE, 'utf8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    } catch (error) {
      console.error('Error reading orders:', error);
      throw error;
    }
  }
}

let store;

export function getOrderStore() {
  if (!store) {
    store = new OrderStore();
  }
  return store;
}
