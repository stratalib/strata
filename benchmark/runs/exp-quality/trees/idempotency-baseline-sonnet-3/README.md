# catalog-service

Internal product catalog API.

- Data model lives in `prisma/schema.prisma` (Product, Supplier, Order, OrderItem).
- All product access goes through `src/data/productRepository.js`, all order access through
  `src/data/orderRepository.js` — routes never touch the store directly.
- Routes are Express routers under `src/routes/`, mounted in `src/server.js`.
- `POST /orders` requires an `idempotencyKey`; retrying the same key returns the original order
  (`replayed: true`) instead of creating a duplicate.
