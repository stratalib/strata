export type PatternKind = 'function' | 'class' | 'arrow' | 'default';

export interface ExtractedPattern {
  name: string;
  kind: PatternKind;
  filePath: string;       // absolute path to source file
  relativePath: string;   // relative to scanned root
  domain: string;         // inferred from directory structure
  subdomain: string;      // inferred from sub-directory or name
  params: string[];       // raw param strings with types preserved
  returnType: string;
  jsdoc: string;
  sourceSnippet: string;  // up to 15 lines from the declaration
  isAsync: boolean;
  isExportDefault: boolean;
}

export interface ScanResult {
  root: string;
  filesScanned: number;
  patterns: ExtractedPattern[];
  skipped: { path: string; reason: string }[];
}

export interface ScanOptions {
  /** Additional directories to exclude (on top of defaults) */
  exclude?: string[];
  /** Maximum file size in bytes to read (default: 200KB) */
  maxFileSize?: number;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
}

/** Slot name → extracted value from the project's source code */
export type ConventionMap = Record<string, string>;

export interface GlueRecallMetadata {
  id: string;
  type: 'glue';
  description: string;
  slots: string[];
  /** Glob-style patterns matched against selected recall IDs: "auth.*", "database.*", or exact ID */
  triggers: string[];
  /** slot name → array of regex strings (first non-empty capture group wins per file) */
  extractors: Record<string, string[]>;
}

export interface ResolvedGlue {
  id: string;
  /** template.js with {{SLOT}} replaced by extracted values */
  filled: string;
  /** slots that had no value in conventions.json — left as {{SLOT}} */
  unfilledSlots: string[];
}
