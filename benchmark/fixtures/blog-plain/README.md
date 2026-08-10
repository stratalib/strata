# blog

Plain-JS blog API. No ORM, no schema file — the model shape is declared in `src/models/post.js`.

- All post access goes through `src/data/postRepository.js`.
- Routes are Express routers under `src/routes/`, mounted in `src/server.js`.
