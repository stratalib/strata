# catalog-service

Internal product catalog API.

- Data model lives in `prisma/schema.prisma` (Product, Supplier).
- All product access goes through `src/data/productRepository.js` — routes never touch the store directly.
- Routes are Express routers under `src/routes/`, mounted in `src/server.js`.
