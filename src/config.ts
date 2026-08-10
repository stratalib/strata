import fs from 'fs';
import path from 'path';
import os from 'os';

export interface StrataConfig {
  mode: 'local' | 'hub';
  hub?: {
    url: string;
    apiKey: string;
  };
}

const configPath = path.join(os.homedir(), '.strata', 'config.json');

// Recalls live on the hub, not in the package — see STRATA-LAUNCH.md. A fresh install with no
// ~/.strata/config.json yet must still work out of the box, so hub mode against the run-of-record
// server is the default, not an opt-in. `mode: 'local'` remains fully supported for anyone who points
// it at their own recalls/ checkout; it just has to be chosen, not assumed.
const DEFAULT_CONFIG: StrataConfig = {
  mode: 'hub',
  hub: { url: process.env.STRATA_HUB_URL || 'http://34.141.19.43:8080', apiKey: '' },
};

/**
 * STRATA_MODE=local — force local composition for THIS process.
 *
 * Without it, the only way to compose against a local recalls/ checkout was to edit
 * ~/.strata/config.json, which changes the mode for every Strata on the machine including the user's
 * editor session. That made a local library change effectively untestable.
 *
 * It cost a whole benchmark to discover. Fifteen stripejune runs were collected against a library that
 * had just been given a Stripe recall locally — and every one of them composed ON THE HUB, which does
 * not have it. The runs measured the hub's 21 recalls while the local checkout said 22, and nothing in
 * the output distinguished the two. Any experiment on an unshipped recall needs this flag, or it is
 * silently measuring production.
 */
export function loadConfig(): StrataConfig {
  const forced = process.env.STRATA_MODE;
  if (forced === 'local') return { mode: 'local' };
  if (fs.existsSync(configPath) === false && forced === 'hub') return DEFAULT_CONFIG;
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  try {
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Merge, not replace: ~/.strata/config.json predates `mode`/`hub` (it started as a home for
    // unrelated settings — consent, telemetry). An existing file with neither key is not a choice for
    // local mode, it is simply older than the field existed, and treating "the file is present" as
    // "the user opted out of the hub" would silently strand every upgrade on local-only. An explicit
    // `mode: 'local'` on disk still wins — this only fills in what's actually missing.
    return { ...DEFAULT_CONFIG, ...onDisk };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: StrataConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
