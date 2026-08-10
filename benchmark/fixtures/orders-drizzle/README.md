# orders

Order management API.

- Data model: `src/db/schema.ts` (Drizzle, Postgres).
- All order access goes through `src/data/orderRepository.js`.
- Routes are Express routers under `src/routes/`, mounted in `src/server.js`.
