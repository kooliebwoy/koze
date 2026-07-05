import { describe, expect, it } from 'vitest';

import { collectReferencedIdentifiers } from '../src/compiler/import-linking.js';
import { collectServerTemplateReferences } from '../src/compiler/parser.js';

describe('template scope references', () => {
  it('does not leak arrow callback parameters as free identifiers', () => {
    const refs = collectReferencedIdentifiers(`selectedFeatures.map((item) => item.id).join(',')`);

    expect(refs.has('selectedFeatures')).toBe(true);
    expect(refs.has('item')).toBe(false);
  });

  it('does not treat destructuring property names as free identifiers', () => {
    const refs = collectReferencedIdentifiers(`const { id: itemId } = item; itemId`);

    expect(refs.has('item')).toBe(true);
    expect(refs.has('id')).toBe(false);
    expect(refs.has('itemId')).toBe(false);
  });

  it('does not leak local template callback parameters into server refs', () => {
    const refs = collectServerTemplateReferences(`
<input type="hidden" value={selectedFeatures.map((item) => item.id).join(',')} />
for (const feature of featureOptions.filter((item) => item.name.includes(searchFeatures))) {
  <div>{feature.name}</div>
}
`);

    expect(refs.has('selectedFeatures')).toBe(true);
    expect(refs.has('featureOptions')).toBe(true);
    expect(refs.has('searchFeatures')).toBe(true);
    expect(refs.has('item')).toBe(false);
    expect(refs.has('feature')).toBe(false);
  });
});
