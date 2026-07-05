import { beforeEach, describe, expect, test } from 'vitest';

import { __setRequestContext } from '../src/runtime/context.js';
import {
  __nextBoundaryId,
  __registerBoundary,
  __takeCollectedBoundaries,
  BOOTSTRAP_SCRIPT,
  boundaryPlaceholder,
  buildChunk,
  resolveBoundaryToChunk,
} from '../src/runtime/stream.js';

describe('streaming SSR runtime', () => {
  beforeEach(() => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});
  });

  test('emits escaped placeholders and deterministic per-request boundary ids', () => {
    expect(__nextBoundaryId('todos')).toBe('todos-1');
    expect(__nextBoundaryId('todos')).toBe('todos-2');
    expect(boundaryPlaceholder('todos-"<1', '<p>loading</p>')).toBe(
      '<div id="__ssr_boundary_todos-&quot;&lt;1" data-kuratchi-boundary="todos-&quot;&lt;1"><p>loading</p></div>',
    );
  });

  test('collects pending boundaries and resolves success chunks as async values', async () => {
    const pending = __registerBoundary(
      'profile-1',
      Promise.resolve({ name: 'Ada' }),
      (value: any) => `<p>${value.success ? value.name : 'missing'}</p>`,
      (message) => `<p>${message}</p>`,
    );

    expect(pending.pending).toBe(true);
    expect(pending.success).toBe(false);

    const boundaries = __takeCollectedBoundaries();
    expect(boundaries).toHaveLength(1);
    expect(__takeCollectedBoundaries()).toEqual([]);

    const chunk = await resolveBoundaryToChunk(boundaries[0]);
    expect(chunk).toBe('<template id="__ssr_chunk_profile-1"><p>Ada</p></template><script>$_swap("profile-1")</script>');
  });

  test('serializes rejected boundaries through the error renderer without breaking the stream', async () => {
    __registerBoundary(
      'profile-1',
      Promise.reject(new Error('not found')),
      () => '<p>ok</p>',
      (message) => `<p class="error">${message}</p>`,
    );

    const [boundary] = __takeCollectedBoundaries();
    const chunk = await resolveBoundaryToChunk(boundary);

    expect(chunk).toBe(
      '<template id="__ssr_chunk_profile-1"><p class="error">not found</p></template><script>$_swap("profile-1")</script>',
    );
  });

  test('bootstrap script swaps streamed templates into pending placeholders', () => {
    expect(BOOTSTRAP_SCRIPT).toContain("document.getElementById('__ssr_boundary_'+i)");
    expect(BOOTSTRAP_SCRIPT).toContain("document.getElementById('__ssr_chunk_'+i)");
    expect(buildChunk('chunk-1', '<strong>done</strong>')).toContain('$_swap("chunk-1")');
  });
});
