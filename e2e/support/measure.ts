// Host-vs-guest position sampling on the fixture page and the machine-readable sync report.
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** R4: max |host - guest| while in sync. */
export const TOLERANCE_SEC = 2.0;

export const REPORT_PATH = fileURLToPath(new URL('../test-results/sync-report.json', import.meta.url));

export interface PlayerReading {
  positionSec: number;
  paused: boolean;
  rate: number;
  /** Date.now() in the page when currentTime was read. */
  atMs: number;
}

export interface DiffSample {
  /** ms since sampling started. */
  t: number;
  /** guest - host in seconds, one per guest, aligned to the host's sampling timestamp. */
  diffs: number[];
  /** paused flags: host first, then guests. */
  paused: boolean[];
}

export interface DiffResult {
  maxAbsDiffSec: number;
  samples: DiffSample[];
}

export interface ScenarioResult {
  scenario: string;
  maxAbsDiffSec: number;
  sampleCount: number;
  passed: boolean;
}

export function readFixture(page: Page): Promise<PlayerReading> {
  return page.evaluate(() => {
    const v = (window as any).__fixture.video as HTMLVideoElement;
    return { positionSec: v.currentTime, paused: v.paused, rate: v.playbackRate, atMs: Date.now() };
  });
}

/** Position projected to `refMs`; a playing element advances by its rate, a paused one does not. */
export function alignedPosition(r: PlayerReading, refMs: number): number {
  return r.paused ? r.positionSec : r.positionSec + ((refMs - r.atMs) / 1000) * r.rate;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Samples every intervalMs from t=0 to t=durationMs inclusive. */
export async function sampleDiffs(
  host: Page,
  guests: Page[],
  opts: { intervalMs: number; durationMs: number },
): Promise<DiffResult> {
  const start = Date.now();
  const samples: DiffSample[] = [];
  let maxAbsDiffSec = 0;
  for (let i = 0; i * opts.intervalMs <= opts.durationMs; i++) {
    const wait = start + i * opts.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    const [h, ...gs] = await Promise.all([host, ...guests].map(readFixture));
    const ref = h!.atMs;
    const hostPos = alignedPosition(h!, ref);
    const diffs = gs.map((g) => alignedPosition(g, ref) - hostPos);
    for (const d of diffs) maxAbsDiffSec = Math.max(maxAbsDiffSec, Math.abs(d));
    samples.push({
      t: ref - start,
      diffs: diffs.map((d) => Math.round(d * 1000) / 1000),
      paused: [h!, ...gs].map((r) => r.paused),
    });
  }
  return { maxAbsDiffSec: Math.round(maxAbsDiffSec * 1000) / 1000, samples };
}

function mergeInto(path: string, result: ScenarioResult): void {
  let list: ScenarioResult[] = [];
  if (existsSync(path)) {
    try {
      list = JSON.parse(readFileSync(path, 'utf8')) as ScenarioResult[];
    } catch {
      list = [];
    }
  }
  list = list.filter((r) => r.scenario !== result.scenario).concat(result);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
}

/**
 * Adds or replaces a scenario in e2e/test-results/sync-report.json. Playwright empties
 * test-results at the start of each run, so when SYNC_REPORT_DIR is set (the task artifact
 * root) the entry is also merged into a copy there that accumulates across runs.
 */
export function recordScenario(result: ScenarioResult): void {
  mergeInto(REPORT_PATH, result);
  const copyDir = process.env.SYNC_REPORT_DIR;
  if (copyDir) mergeInto(join(copyDir, 'sync-report.json'), result);
}
