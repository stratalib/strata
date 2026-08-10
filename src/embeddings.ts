// Local, offline semantic similarity — no network calls, no API keys, no per-query LLM cost.
//
// This exists to fix a real failure mode: lexical scoring (scoreRecall in mcp-server.ts) matches
// on raw token overlap, so "background job for a receipt" and "background job for a CSV export"
// score similarly because both contain the token "job" — even though the two are unrelated. A
// small fixed-weight embedding model has no trouble telling them apart; it's a deterministic
// vector transform, not a judgment call, so it runs in the hot path the same way a hash function
// would.
//
// Used as a PRECISION FILTER layered on top of lexical scoring, not a replacement for it. Lexical
// matching (especially DOMAIN_PRIORITY's exact package-name forcing) stays the primary signal —
// semantic similarity only vetoes candidates that cleared the lexical bar by accident.

// @xenova/transformers ships ESM-only. This project compiles to CommonJS, so a static
// `import` would become a `require()` and crash at runtime with ERR_REQUIRE_ESM. A dynamic
// `import()` is the standard, correct way to load an ESM-only package from CJS — TypeScript
// preserves it as a real dynamic import even under a commonjs module target.
import type { FeatureExtractionPipeline } from '@xenova/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedder: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (embedder) return embedder;
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', MODEL_ID) as unknown as FeatureExtractionPipeline;
    })();
  }
  embedder = await loading;
  return embedder;
}

// Returns a mean-pooled, L2-normalized embedding — normalized so cosineSimilarity()
// can skip the magnitude division and just take the dot product.
export async function embedText(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data as ArrayLike<number>);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // both vectors are pre-normalized, so dot product IS cosine similarity
}

export { MODEL_ID };
