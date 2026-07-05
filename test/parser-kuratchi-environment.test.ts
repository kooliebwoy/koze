import { describe, expect, test } from 'vitest';
import { parseFile } from '../src/compiler/parser.ts';

describe('parser koze:environment handling', () => {
  // koze:environment works in all scripts (client-side).
  // The dev flag is serialized for client access.

  test('extracts dev alias from koze:environment import', () => {
    const source = `
<script>
  import { dev } from 'koze:environment';
  
  if (dev) console.log('dev mode');
</script>
<div>Hello</div>
`;
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    expect(result.devAliases).toContain('dev');
  });

  test('extracts dev alias from legacy koze/environment import', () => {
    const source = `
<script>
  import { dev } from '@kuratchi/koze/environment';
  
  if (dev) console.log('dev mode');
</script>
<div>Hello</div>
`;
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    expect(result.devAliases).toContain('dev');
  });

  test('extracts renamed dev alias', () => {
    const source = `
<script>
  import { dev as isDevelopment } from 'koze:environment';
  
  const check = isDevelopment;
</script>
<div>Hello</div>
`;
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    expect(result.devAliases).toContain('isDevelopment');
  });

  test('extracts dev alias from reactive script', () => {
    const source = `
<script>
  import { dev } from 'koze:environment';
  
  $: if (dev) console.log('reactive dev check');
</script>
<div>Hello</div>
`;
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    expect(result.devAliases).toContain('dev');
  });

  test('throws error for non-dev exports from koze:environment', () => {
    const source = `
<script>
  import { prod } from 'koze:environment';
</script>
<div>Hello</div>
`;
    
    expect(() => parseFile(source, { kind: 'route', filePath: 'test.koze' }))
      .toThrow(/koze:environment export 'prod' is not available in route context/);
  });

  test('devAliases is empty when no koze:environment import', () => {
    const source = `
<script>
  console.log('no env import');
</script>
<div>Hello</div>
`;
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    expect(result.devAliases).toEqual([]);
  });
});
