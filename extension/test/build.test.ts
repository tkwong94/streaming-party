import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_MATCHES = ['https://www.netflix.com/watch/*', 'https://www.youtube.com/watch*'];
const FIXTURE_MATCH = 'http://127.0.0.1/*';

interface Manifest {
  manifest_version: number;
  permissions: string[];
  action: { default_popup: string };
  content_scripts: { matches: string[]; js: string[]; run_at: string; world?: string }[];
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(EXT_ROOT, dir, 'manifest.json'), 'utf8')) as Manifest;
}

describe('extension build', () => {
  it('build_outputs_valid_manifests', () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: EXT_ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, ['build.mjs', '--test'], { cwd: EXT_ROOT, stdio: 'pipe' });

    const dist = readManifest('dist');
    const distTest = readManifest('dist-test');

    for (const [dir, manifest] of [
      ['dist', dist],
      ['dist-test', distTest],
    ] as const) {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(['storage', 'tabs']);
      expect(manifest.action.default_popup).toBe('popup.html');
      expect(manifest.content_scripts).toHaveLength(2);
      expect(manifest.content_scripts[0]!.js).toEqual(['content.js']);
      expect(manifest.content_scripts[0]!.run_at).toBe('document_start');
      expect(manifest.content_scripts[1]).toEqual({
        matches: ['https://www.netflix.com/watch/*'],
        js: ['netflix-page-bridge.js'],
        run_at: 'document_start',
        world: 'MAIN',
      });
      for (const file of ['content.js', 'popup.js', 'popup.html', 'netflix-page-bridge.js']) {
        expect(existsSync(join(EXT_ROOT, dir, file)), `${dir}/${file}`).toBe(true);
      }
    }

    expect(dist.content_scripts[0]!.matches).toEqual(SITE_MATCHES);
    expect(dist.content_scripts[0]!.matches).not.toContain(FIXTURE_MATCH);
    expect(distTest.content_scripts[0]!.matches).toEqual([...SITE_MATCHES, FIXTURE_MATCH]);
  }, 30_000);
});
