import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SVELTEKIT_PARITY_FIXTURES,
  getSvelteKitParityFixtures,
} from './fixtures/sveltekit-parity/manifest.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('SvelteKit parity matrix', () => {
  const portedPass = getSvelteKitParityFixtures('ported-pass');
  const portedFail = getSvelteKitParityFixtures('ported-fail');
  const futureFeature = getSvelteKitParityFixtures('future-feature');
  const notApplicable = getSvelteKitParityFixtures('not-applicable');

  it('tracks framework parity separately from Svelte compiler parity', () => {
    expect(portedPass.length).toBeGreaterThanOrEqual(15);
    expect(portedFail).toHaveLength(0);
    expect(futureFeature).toHaveLength(0);
    expect(notApplicable.length).toBeGreaterThan(0);
    expect(new Set(SVELTEKIT_PARITY_FIXTURES.map((fixture) => fixture.id)).size)
      .toBe(SVELTEKIT_PARITY_FIXTURES.length);
  });

  for (const fixture of portedPass) {
    it(`evidence: ${fixture.id}`, () => {
      expect(fixture.evidence, `${fixture.id} must point at a concrete Kuratchi test`).toBeTruthy();
      const evidence = fixture.evidence!;
      const filePath = path.join(packageRoot, evidence.file);
      const source = fs.readFileSync(filePath, 'utf8');

      expect(source, `${fixture.id} evidence file is missing test name`).toContain(evidence.testName);
    });
  }
});
