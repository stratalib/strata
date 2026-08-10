/**
 * RecallManager: Orchestrates retrieval, composition, and learning
 * Implements the three-tier (Snippet/Code/System) architecture
 */

import fs from 'fs';
import path from 'path';

export interface RecallMetadata {
  id: string;
  name: string;
  description: string;
  domain: string;
  subdomain?: string;
  entity?: string;
  layer: 'snippet' | 'code' | 'system';
  lineCount: number;
  tags: string[];
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  version: string;
  tested: boolean;
  implementationPath: string;
  testPath: string;
  typesPath: string;
  docPath: string;
  metrics?: {
    timesRetrieved: number;
    timesUsedInCode: number;
    timesUsedInSystem: number;
    averageEditDistance: number;
    lastImproved: string;
    userRating: number;
  };
}

export interface Composition {
  layer: 'code' | 'system';
  snippetComposition: Array<{
    snippetId: string;
    role: string;
    integration: string;
  }>;
  codeComposition?: Array<{
    codeId: string;
    role: string;
    integration: string;
  }>;
}

export interface RetrievalResult {
  layer: 'snippet' | 'code' | 'system';
  primary: RecallMetadata;
  dependencies: RecallMetadata[];
  composition?: Composition;
  estimatedGlueTokens: number;
}

export interface UsageEvent {
  requestId: string;
  timestamp: string;
  layer: 'snippet' | 'code' | 'system';
  retrievedIds: string[];
  glueTokensEstimated: number;
  glueTokensActual: number;
  userEditDistance: number;
  testsPassed: boolean;
  productionDeployed: boolean;
  userRating: 1 | 2 | 3 | 4 | 5;
  success: boolean;
}

class RecallManager {
  private recallsDir: string;
  private libraryIndex: any;
  private usageEvents: UsageEvent[] = [];

  constructor(recallsDir?: string) {
    this.recallsDir = recallsDir || path.join(process.cwd(), 'recalls');
  }

  async init(): Promise<void> {
    // Load library index
    const indexPath = path.join(this.recallsDir, 'library-index.json');
    if (fs.existsSync(indexPath)) {
      this.libraryIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }
  }

  /**
   * Search all layers for matching Recalls
   */
  search(query: string): {
    snippets: RecallMetadata[];
    codes: RecallMetadata[];
    systems: RecallMetadata[];
  } {
    if (!this.libraryIndex) {
      throw new Error('RecallManager not initialized. Call .init() first.');
    }

    const lowerQuery = query.toLowerCase();

    const matches = {
      snippets: this.libraryIndex.snippets
        .filter((s: any) =>
          s.id.toLowerCase().includes(lowerQuery) ||
          s.name?.toLowerCase().includes(lowerQuery) ||
          s.tags?.some((t: string) => t.toLowerCase().includes(lowerQuery))
        )
        .slice(0, 10),
      codes: this.libraryIndex.codes
        .filter((c: any) =>
          c.id.toLowerCase().includes(lowerQuery) ||
          c.name?.toLowerCase().includes(lowerQuery) ||
          c.tags?.some((t: string) => t.toLowerCase().includes(lowerQuery))
        )
        .slice(0, 10),
      systems: this.libraryIndex.systems
        .filter((s: any) =>
          s.id.toLowerCase().includes(lowerQuery) ||
          s.name?.toLowerCase().includes(lowerQuery) ||
          s.tags?.some((t: string) => t.toLowerCase().includes(lowerQuery))
        )
        .slice(0, 10)
    };

    return matches;
  }

  /**
   * Score a Recall for a given request
   * Weights:
   *   - Token savings: 30%
   *   - Reusability: 25%
   *   - Edit distance: 20%
   *   - Composability: 15%
   *   - Freshness: 10%
   */
  scoreRecall(recall: RecallMetadata, request: string): number {
    const weights = {
      tokenSavings: 0.30,
      reusability: 0.25,
      editDistance: 0.20,
      composability: 0.15,
      freshness: 0.10
    };

    // 1. Token savings (0-100)
    const lineCount = recall.lineCount || 50;
    const estimatedTokens = Math.ceil(lineCount * 1.3);
    const tokenScore = Math.min(100, (estimatedTokens / 1500) * 100);

    // 2. Reusability (0-100)
    const timesRetrieved = recall.metrics?.timesRetrieved || 0;
    const reusabilityScore = Math.min(100, timesRetrieved * 5);

    // 3. Edit distance (0-100) - lower edits = better
    const editDist = recall.metrics?.averageEditDistance || 50;
    const editScore = 100 - editDist;

    // 4. Composability (0-100)
    let composabilityScore = 50;
    if (recall.layer === 'snippet') {
      const usedInCode = recall.metrics?.timesUsedInCode || 0;
      composabilityScore = Math.min(100, usedInCode * 10);
    } else if (recall.layer === 'code') {
      const usedInSystem = recall.metrics?.timesUsedInSystem || 0;
      composabilityScore = Math.min(100, usedInSystem * 5);
    }

    // 5. Freshness (0-100)
    const lastImprovedStr = recall.metrics?.lastImproved;
    let freshnessScore = 100;
    if (lastImprovedStr) {
      const lastImproved = new Date(lastImprovedStr);
      const daysSinceImproved = (Date.now() - lastImproved.getTime()) / (1000 * 60 * 60 * 24);
      freshnessScore = Math.max(0, 100 - (daysSinceImproved / 365) * 20);
    }

    // Weighted total
    const totalScore =
      tokenScore * weights.tokenSavings +
      reusabilityScore * weights.reusability +
      editScore * weights.editDistance +
      composabilityScore * weights.composability +
      freshnessScore * weights.freshness;

    return Math.round(totalScore);
  }

  /**
   * Optimize retrieval path: find best layer for user request
   * Returns ONE selected path (not alternatives)
   */
  optimizeRetrievalPath(request: string): { layer: 'snippet' | 'code' | 'system'; id: string; score: number } {
    const searchResults = this.search(request);

    const candidates = [
      ...(searchResults.snippets || []).map((s: any) => ({
        layer: 'snippet' as const,
        id: s.id,
        score: this.scoreRecall(this.loadMetadata('snippet', s.id), request)
      })),
      ...(searchResults.codes || []).map((c: any) => ({
        layer: 'code' as const,
        id: c.id,
        score: this.scoreRecall(this.loadMetadata('code', c.id), request)
      })),
      ...(searchResults.systems || []).map((s: any) => ({
        layer: 'system' as const,
        id: s.id,
        score: this.scoreRecall(this.loadMetadata('system', s.id), request)
      }))
    ];

    if (candidates.length === 0) {
      throw new Error(`No Recalls found matching: ${request}`);
    }

    // Return ONLY the top-scoring path
    return candidates.sort((a, b) => b.score - a.score)[0];
  }

  /**
   * Load metadata for a specific Recall
   */
  private loadMetadata(layer: 'snippet' | 'code' | 'system', id: string): RecallMetadata {
    const [domain, entity] = this.parseRecallId(id);
    const metadataPath = path.join(
      this.recallsDir,
      layer + 's',
      domain,
      entity,
      'v1',
      'metadata.json'
    );

    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Recall not found: ${id}`);
    }

    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  }

  /**
   * Parse recall ID (e.g., "auth.passwordhashing" -> ["auth", "passwordhashing"])
   */
  private parseRecallId(id: string): [string, string] {
    const parts = id.split('.');
    return [parts[0], parts.slice(1).join('-')];
  }

  /**
   * Retrieve a Recall with its dependencies
   */
  async retrieve(request: string): Promise<RetrievalResult> {
    const selectedPath = this.optimizeRetrievalPath(request);
    const primary = this.loadMetadata(selectedPath.layer, selectedPath.id);

    const dependencies: RecallMetadata[] = [];
    let composition: Composition | undefined;
    let estimatedGlueTokens = 50;

    // Load dependencies based on layer
    if (selectedPath.layer === 'code' || selectedPath.layer === 'system') {
      const compositionPath = path.join(
        this.recallsDir,
        selectedPath.layer + 's',
        primary.domain,
        primary.entity,
        'v1',
        'composition.json'
      );

      if (fs.existsSync(compositionPath)) {
        composition = JSON.parse(fs.readFileSync(compositionPath, 'utf-8'));

        // Load snippet dependencies
        if (composition.snippetComposition) {
          for (const dep of composition.snippetComposition) {
            try {
              const snippet = this.loadMetadata('snippet', dep.snippetId);
              dependencies.push(snippet);
              estimatedGlueTokens += (dep.integration?.split('\n').length || 0) * 1.3;
            } catch (e) {
              console.warn(`Could not load dependency: ${dep.snippetId}`);
            }
          }
        }

        // Load code dependencies (for systems)
        if (composition.codeComposition) {
          for (const dep of composition.codeComposition) {
            try {
              const code = this.loadMetadata('code', dep.codeId);
              dependencies.push(code);
              estimatedGlueTokens += (dep.integration?.split('\n').length || 0) * 1.3;
            } catch (e) {
              console.warn(`Could not load dependency: ${dep.codeId}`);
            }
          }
        }
      }
    }

    return {
      layer: selectedPath.layer,
      primary,
      dependencies,
      composition,
      estimatedGlueTokens: Math.ceil(estimatedGlueTokens)
    };
  }

  /**
   * Record usage event for learning loop
   */
  async recordUsage(event: UsageEvent): Promise<void> {
    this.usageEvents.push(event);

    // Update metrics on affected Recalls
    for (const recallId of event.retrievedIds) {
      try {
        const [layer, domain, entity] = this.parseRecallPathFromId(recallId);
        const metadataPath = path.join(
          this.recallsDir,
          layer,
          domain,
          entity,
          'v1',
          'metadata.json'
        );

        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

          // Update metrics
          if (!metadata.metrics) {
            metadata.metrics = {
              timesRetrieved: 0,
              timesUsedInCode: 0,
              timesUsedInSystem: 0,
              averageEditDistance: 0,
              lastImproved: new Date().toISOString(),
              userRating: 0
            };
          }

          metadata.metrics.timesRetrieved++;
          metadata.metrics.averageEditDistance =
            (metadata.metrics.averageEditDistance + event.userEditDistance) / 2;

          if (event.success && event.userRating) {
            metadata.metrics.userRating =
              (metadata.metrics.userRating + event.userRating) / 2;
          }

          metadata.metrics.lastImproved = new Date().toISOString();

          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        }
      } catch (e) {
        console.warn(`Failed to update metrics for ${recallId}:`, e);
      }
    }

    // Persist usage events
    const eventsPath = path.join(this.recallsDir, 'usage-events.jsonl');
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
  }

  /**
   * Parse recall ID back to layer and path parts
   */
  private parseRecallPathFromId(id: string): [string, string, string] {
    // This is a simplified parse; in production you'd track the full path
    const parts = id.split('.');
    const domain = parts[0];
    const entity = parts.slice(1).join('-');
    const layer = 'snippets'; // Would need to determine this

    return [layer, domain, entity];
  }

  /**
   * Get library statistics
   */
  getStats() {
    if (!this.libraryIndex) {
      throw new Error('RecallManager not initialized');
    }

    return {
      totalSnippets: this.libraryIndex.stats.totalSnippets,
      totalCodes: this.libraryIndex.stats.totalCodes,
      totalSystems: this.libraryIndex.stats.totalSystems,
      totalRecalls: this.libraryIndex.stats.totalRecalls,
      usageEvents: this.usageEvents.length
    };
  }
}

export default RecallManager;
