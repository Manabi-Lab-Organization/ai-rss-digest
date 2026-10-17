import { describe, it, expect } from 'vitest';
import { formatTtsUsage } from '../podcastBuilder.js';

const PRO_TTS = 'gemini-pro-tts';

describe('formatTtsUsage：音声合成の使用量を1行にまとめる', () => {
  it('出力トークンを1分あたりの数に換算して載せる', () => {
    const line = formatTtsUsage({ promptTokens: 4000, audioTokens: 180_000 }, 1800, PRO_TTS);
    expect(line).toContain('30.0分');
    expect(line).toContain('6,000 tok/分');
  });

  it('入力と出力のトークン数を桁区切りで載せる', () => {
    const line = formatTtsUsage({ promptTokens: 4000, audioTokens: 180_000 }, 1800, PRO_TTS);
    expect(line).toContain('入力 4,000 tok');
    expect(line).toContain('出力 180,000 tok');
  });

  it('概算の金額をモデルの単価から計算して載せる', () => {
    const line = formatTtsUsage({ promptTokens: 4000, audioTokens: 180_000 }, 1800, PRO_TTS);
    expect(line).toContain('$3.60');
  });

  it('長さが0秒でもエラーにならず、0として表示する', () => {
    const line = formatTtsUsage({ promptTokens: 0, audioTokens: 0 }, 0, PRO_TTS);
    expect(line).toContain('0 tok/分');
    expect(line).toContain('$0.00');
  });

  it('長さが同じなら、出力トークンが多いほど1分あたりの数も大きくなる', () => {
    const before = formatTtsUsage({ promptTokens: 4000, audioTokens: 180_000 }, 1800, PRO_TTS);
    const after = formatTtsUsage({ promptTokens: 3000, audioTokens: 198_000 }, 1800, PRO_TTS);
    expect(before).toContain('6,000 tok/分');
    expect(after).toContain('6,600 tok/分');
  });
});
