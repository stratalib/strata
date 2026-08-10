/**
 * Glue Matcher
 * Given a set of selected recall IDs and a ConventionMap, finds all glue
 * templates whose triggers match any of the recalls and fills {{SLOT}}
 * placeholders with extracted project values.
 *
 * Called by strata_use after recall selection so Claude receives structural
 * patterns already adapted to the project's codebase — zero LLM involvement.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConventionMap, GlueRecallMetadata, ResolvedGlue } from './types';

const SLOT_RE = /\{\{([A-Z_]+)\}\}/g;
const MAX_GLUE_PER_CALL = 5;

/* ── Trigger matching ──────────────────────────────────────────────── */

function matchesTrigger(recallId: string, trigger: string): boolean {
  if (trigger.endsWith('.*')) {
    // "auth.*" → recall must start with "auth."
    const prefix = trigger.slice(0, -1); // "auth."
    return recallId.startsWith(prefix);
  }
  return recallId === trigger;
}

function isTriggered(recallIds: string[], triggers: string[]): boolean {
  return recallIds.some(id => triggers.some(t => matchesTrigger(id, t)));
}

/* ── Load a glue template + fill slots ─────────────────────────────── */

function fillTemplate(templatePath: string, conventions: ConventionMap): {
  filled: string; unfilledSlots: string[];
} {
  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return { filled: '', unfilledSlots: [] };
  }

  const unfilledSlots: string[] = [];
  const filled = template.replace(SLOT_RE, (match, slot: string) => {
    const value = conventions[slot];
    if (value) return value;
    unfilledSlots.push(slot);
    return match; // leave {{SLOT}} as-is — Claude fills from context
  });

  return { filled, unfilledSlots };
}

/* ── Main resolveGlue function ──────────────────────────────────────── */

export function resolveGlue(
  recallIds: string[],
  conventions: ConventionMap,
  glueDir: string,
): ResolvedGlue[] {
  if (!fs.existsSync(glueDir) || recallIds.length === 0) return [];

  const results: ResolvedGlue[] = [];
  const seen = new Set<string>();

  // Sorted for determinism — more specific IDs score first
  const sortedRecalls = [...recallIds].sort();

  for (const templateName of fs.readdirSync(glueDir).sort()) {
    if (results.length >= MAX_GLUE_PER_CALL) break;

    const metaPath = path.join(glueDir, templateName, 'v1', 'metadata.json');
    const templatePath = path.join(glueDir, templateName, 'v1', 'template.js');

    if (!fs.existsSync(metaPath) || !fs.existsSync(templatePath)) continue;

    let meta: GlueRecallMetadata;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      continue;
    }

    if (seen.has(meta.id)) continue;
    if (!isTriggered(sortedRecalls, meta.triggers)) continue;

    const { filled, unfilledSlots } = fillTemplate(templatePath, conventions);
    if (!filled.trim()) continue;

    seen.add(meta.id);
    results.push({ id: meta.id, filled, unfilledSlots });
  }

  return results;
}

/* ── Load conventions from a project directory ──────────────────────── */

export function loadConventions(projectDir: string): ConventionMap {
  const conventionsPath = path.join(projectDir, 'strata', 'conventions.json');
  if (!fs.existsSync(conventionsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(conventionsPath, 'utf-8'));
  } catch {
    return {};
  }
}
