import { describe, expect, test } from 'vitest';

import { __setRequestContext } from '../src/runtime/context.ts';
import { __setPipelineRegistry, pipeline, pipelines, sendPipeline } from '../src/runtime/pipeline.ts';

describe('runtime pipeline helper', () => {
  test('sends single records and arrays through the registered binding', async () => {
    const sent: unknown[][] = [];
    __setPipelineRegistry({
      analytics: {
        binding: 'ANALYTICS_PIPELINE',
        pipeline: 'analytics-stream',
      },
    });
    __setRequestContext(
      {} as ExecutionContext,
      new Request('https://example.com/'),
      {
        ANALYTICS_PIPELINE: {
          async send(records: unknown[]) {
            sent.push(records);
          },
        },
      },
    );

    const analytics = pipeline<{ event: string }>('analytics');
    await analytics.send({ event: 'view' });
    await sendPipeline('analytics', [{ event: 'click' }]);
    await pipelines.analytics.send({ event: 'submit' });

    expect(analytics.binding).toBe('ANALYTICS_PIPELINE');
    expect(analytics.pipeline).toBe('analytics-stream');
    expect(sent).toEqual([
      [{ event: 'view' }],
      [{ event: 'click' }],
      [{ event: 'submit' }],
    ]);
  });
});
