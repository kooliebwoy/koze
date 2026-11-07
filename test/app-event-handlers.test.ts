import { describe, expect, it } from 'vitest';
import { transformAppFile, type ClientFragment } from '../src/compiler/application-pipeline';

describe('app shell event handlers', () => {
  it('connects shell events to the registered browser handlers instead of emitting inert inline calls', () => {
    const fragments = new Map<string, ClientFragment>();
    const compiled = transformAppFile(`<script>
      function active() { console.log('active'); }
    </script>
    <!doctype html><html><head></head><body onpointermove={active()}><slot></slot></body></html>`, false, fragments, false, '/workspace/src/app.koze');
    expect(compiled.code).not.toContain('onpointermove="active(');
    expect(compiled.code).toContain('data-k');
    const fragment = [...fragments.values()].find((f) => f.kind === 'leading')!;
    expect(fragment.needsBridge).toBe(true);
    expect(fragment.handlerRegistry?.handlerCount).toBe(1);
  });
});
