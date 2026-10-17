import { describe, it, expect, afterEach } from 'vitest';
import { getEditionEffort, type AnthropicMessageBody } from '../anthropicClient.js';
import { generateBatch, type Representative } from '../generate.js';

const rep: Representative = {
  rep: { id: '1', feedId: 1, title: 't', summaryRaw: 's', content: '', clusterId: null, triageScore: 5 },
  memberIds: ['1'], clusterSize: 1, feedCount: 1, sourceCount: 1,
};

describe('紙面生成の effort 設定', () => {
  afterEach(() => { delete process.env.DIGEST_EDITION_EFFORT; });

  it('何も設定しなければ medium', () => {
    expect(getEditionEffort()).toBe('medium');
  });

  it('環境変数の値を使い、使えない値なら medium に戻す', () => {
    process.env.DIGEST_EDITION_EFFORT = 'high';
    expect(getEditionEffort()).toBe('high');
    process.env.DIGEST_EDITION_EFFORT = 'fast';
    expect(getEditionEffort()).toBe('medium');
  });

  it('生成リクエストの output_config.effort に設定値が入る', async () => {
    let sent: AnthropicMessageBody | undefined;
    await generateBatch([rep], {
      profileText: 'p',
      createMessageFn: async (body) => {
        sent = body;
        return { content: [{ type: 'text', text: '[{"id":"1","headline":"h","lead":"l","body":"b","section":"総合"}]' }] };
      },
    });
    expect(sent?.output_config).toEqual({ effort: 'medium' });
  });
});

describe('音声台本の effort 設定', () => {
  afterEach(() => { delete process.env.DIGEST_PODCAST_SCRIPT_EFFORT; });
  it('既定は medium で、環境変数で変えられ、使えない値なら medium に戻す', async () => {
    const { getPodcastScriptEffort } = await import('../podcastScript.js');
    expect(getPodcastScriptEffort()).toBe('medium');
    process.env.DIGEST_PODCAST_SCRIPT_EFFORT = 'high';
    expect(getPodcastScriptEffort()).toBe('high');
    process.env.DIGEST_PODCAST_SCRIPT_EFFORT = 'x';
    expect(getPodcastScriptEffort()).toBe('medium');
  });
});
