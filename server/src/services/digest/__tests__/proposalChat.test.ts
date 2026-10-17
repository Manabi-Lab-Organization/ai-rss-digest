import { describe, it, expect } from 'vitest';
import {
  buildRevisePrompt,
  normalizeTurns,
  parseProfileFence,
  reviseProposal,
  type ProposalTurn,
} from '../proposalChat.js';
import type { AnthropicMessageResponse } from '../anthropicClient.js';

const PROFILE = `# 変更点(2054-03-14): 園芸の話題を少し増やす\n\nversion: 4\n\n紙面の方針:\n  - 朝の数分で読み終えられる量に絞り、要点が先に分かる記事を選ぶ\n  - 家庭菜園と季節の植物の話題は、週に二本程度を目安に載せる\n`;

function textResponse(text: string, stopReason = 'end_turn'): AnthropicMessageResponse {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: stopReason,
  };
}

describe('parseProfileFence', () => {
  it('返事の文と profile 枠の中の案を分けて取り出す', () => {
    const r = parseProfileFence(`園芸の話題を増やす方針を書き加えました。\n\n\`\`\`profile\n${PROFILE}\`\`\``);
    expect(r.cleanReply).toBe('園芸の話題を増やす方針を書き加えました。');
    expect(r.revisedProfile).toContain('家庭菜園と季節の植物');
  });

  it('枠が無いときは案を返さず、返事の文だけを返す', () => {
    const r = parseProfileFence('その点は「季節の話題」の項目ですでに扱っています。書き足しますか？');
    expect(r.revisedProfile).toBeNull();
    expect(r.cleanReply).toContain('季節の話題');
  });

  it('枠が二つ以上あるときは最後の枠を案とし、返事の文からは枠をすべて除く', () => {
    const r = parseProfileFence(
      `書き直しました。\n\`\`\`profile\n最初の案です。${'x'.repeat(120)}\n\`\`\`\nこちらに差し替えます。\n\`\`\`profile\n${PROFILE}\`\`\``,
    );
    expect(r.revisedProfile).toContain('version: 4');
    expect(r.cleanReply).not.toContain('```');
    expect(r.cleanReply).toContain('こちらに差し替えます。');
  });

  it('枠の中身が短すぎるときは案として使わない', () => {
    const r = parseProfileFence('書き直しました。\n```profile\nversion: 4\n```');
    expect(r.revisedProfile).toBeNull();
    expect(r.cleanReply).toBe('書き直しました。');
  });
});

describe('buildRevisePrompt', () => {
  const history: ProposalTurn[] = [
    { role: 'user', content: '園芸の記事がもう少し読みたい' },
    { role: 'assistant', content: '園芸の扱いを方針に書き加えました' },
  ];

  it('今の方針と見直し中の案を、それぞれ別のタグで渡す', () => {
    const { system } = buildRevisePrompt('いまの方針の文', '見直し中の案の文', history);
    expect(system).toContain('<current_profile>');
    expect(system).toContain('いまの方針の文');
    expect(system).toContain('<draft_profile>');
    expect(system).toContain('見直し中の案の文');
  });

  it('案を直さずに返事だけしてよい場合の指示が入っている', () => {
    const { system } = buildRevisePrompt('方針', '案', history);
    expect(system).toContain('案を変えないターンでは');
  });

  it('会話の履歴はそのまま messages として渡す', () => {
    const { messages } = buildRevisePrompt('方針', '案', history);
    expect(messages).toEqual(history);
  });

  it('履歴が長いときは新しい方だけを残し、先頭は利用者の発言になる', () => {
    const long: ProposalTurn[] = Array.from({ length: 51 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `メッセージ${i}`,
    }));
    const { messages } = buildRevisePrompt('方針', '案', long);
    expect(messages.length).toBeLessThanOrEqual(30);
    expect(messages[0].role).toBe('user');
    expect(messages[messages.length - 1].content).toBe('メッセージ50');
  });
});

describe('normalizeTurns', () => {
  it('最初に来る assistant の発言は取り除く', () => {
    const r = normalizeTurns([
      { role: 'assistant', content: 'P' },
      { role: 'user', content: 'Q' },
    ]);
    expect(r).toEqual([{ role: 'user', content: 'Q' }]);
  });

  it('利用者の発言が続いたときは一つにつなげる', () => {
    const r = normalizeTurns([
      { role: 'user', content: '園芸を増やして' },
      { role: 'user', content: 'それと天気の話も短くして' },
      { role: 'assistant', content: '書き直しました' },
    ]);
    expect(r).toEqual([
      { role: 'user', content: '園芸を増やして\n\nそれと天気の話も短くして' },
      { role: 'assistant', content: '書き直しました' },
    ]);
  });

  it('渡した配列そのものは変更しない', () => {
    const input: ProposalTurn[] = [
      { role: 'user', content: 'p' },
      { role: 'user', content: 'q' },
    ];
    normalizeTurns(input);
    expect(input[0].content).toBe('p');
  });
});

describe('reviseProposal', () => {
  it('案つきの返事から reply と revisedProfile を取り出す', async () => {
    const r = await reviseProposal(
      { currentProfile: '方針', draftProfile: '案', history: [{ role: 'user', content: '園芸を増やして' }] },
      { createMessageFn: async () => textResponse(`書き直しました。\n\`\`\`profile\n${PROFILE}\`\`\``) },
    );
    expect(r.reply).toBe('書き直しました。');
    expect(r.revisedProfile).toContain('version: 4');
  });

  it('質問に答えるだけの返事では revisedProfile が null になる', async () => {
    const r = await reviseProposal(
      { currentProfile: '方針', draftProfile: '案', history: [{ role: 'user', content: 'どうしてこう直したの？' }] },
      { createMessageFn: async () => textResponse('園芸の記事に👍が5件付いていたからです。') },
    );
    expect(r.revisedProfile).toBeNull();
    expect(r.reply).toContain('👍が5件');
  });

  it('出力が長さの上限で切れたときは案を使わず、そのことを返事に書く', async () => {
    const r = await reviseProposal(
      { currentProfile: '方針', draftProfile: '案', history: [{ role: 'user', content: 'まとめて直して' }] },
      { createMessageFn: async () => textResponse(`書き直しました。\n\`\`\`profile\n${PROFILE}\`\`\``, 'max_tokens') },
    );
    expect(r.revisedProfile).toBeNull();
    expect(r.reply).toContain('途切れた');
  });

  it('返事が空のときはエラーにする', async () => {
    await expect(
      reviseProposal(
        { currentProfile: '方針', draftProfile: '案', history: [{ role: 'user', content: 'y' }] },
        { createMessageFn: async () => textResponse('   ') },
      ),
    ).rejects.toThrow('返答が返りませんでした');
  });
});
