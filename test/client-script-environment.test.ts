import { describe, expect, test } from 'vitest';

import { parseFile } from '../src/compiler/parser.ts';

describe('client script virtual-module validation', () => {
  test('extracts reactive client scripts and $server RPC imports', () => {
    const result = parseFile(`<script>
import { dev } from 'koze:environment';
import { getData } from '$server/api';

const data = await getData();
$: if (dev) console.log('Dev mode!', data);
</script>
<div>{data}</div>`, { kind: 'route', filePath: 'test.koze' });

    expect(result.clientScriptRaw).toBeTruthy();
    expect(result.serverRpcImports[0]).toContain('$server/api');
    expect(result.serverRpcFunctions).toContain('getData');
    expect(result.devAliases).toContain('dev');
  });

  test('rejects unsafe koze:request exports in route scripts', () => {
    expect(() => parseFile(`<script>
import { headers } from 'koze:request';
import { getData } from '$server/api';
console.log(headers.get('Authorization'));
</script>
<div>test</div>`, { kind: 'route', filePath: 'test.koze' })).toThrow(
      "koze:request export 'headers' is not available in route context",
    );
  });

  test('rejects server-only koze:cookies imports in route scripts', () => {
    expect(() => parseFile(`<script>
import { cookies } from 'koze:cookies';
</script>
<div>test</div>`, { kind: 'route', filePath: 'test.koze' })).toThrow(
      "koze:cookies export 'cookies' is not available in route context",
    );
  });

  test('rejects removed virtual-module and source-extension imports', () => {
    expect(() => parseFile(`<script>
import { url } from 'kuratchi:request';
</script>`, { kind: 'route', filePath: 'test.koze' })).toThrow(
      'Use the koze: virtual-module namespace and .koze source extension',
    );

    expect(() => parseFile(`<script>
import Card from '$lib/card.kuratchi';
</script>`, { kind: 'route', filePath: 'test.koze' })).toThrow(
      'Use the koze: virtual-module namespace and .koze source extension',
    );
  });
});
