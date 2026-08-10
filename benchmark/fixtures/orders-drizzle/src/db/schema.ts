import { pgTable, serial, varchar, text, integer, numeric, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const statusEnum = pgEnum('status', ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED']);

export const orders = pgTable('orders', {
  id:        serial('id').primaryKey(),
  reference: varchar('reference', { length: 32 }).notNull(),
  customer:  varchar('customer', { length: 120 }).notNull(),
  memo:      text('memo'),
  total:     numeric('total').notNull(),
  quantity:  integer('quantity').notNull(),
  status:    statusEnum('status').notNull(),
  rush:      boolean('rush').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});
