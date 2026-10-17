import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanForTts, buildUtteranceRequest, trailingSilenceBytes, leadingSilenceBytes,
  closeCutBytes, trimForJoin, pcmToWav, synthesizeScript, stripTrailingFarewell,
  voiceMap, mergeAdjacentSpeakers, CHUNK_CHARS, RATE, STYLE_PROMPT,
  usesInteractionsApi, buildInteractionsRequest, extractInteractionsAudio, pcmFromWav,
  extractTitledNames, findMisreadByReading, checkUtteranceReading, summarizeReadingChecks, getTtsModel,
  lookupNameReadings, normalizeKana, readingOfName, formatNameReadingLog, familyReadingOf, formatMisreadWarning,
  type TtsFetchLike, type ReadingCheckResult,
} from '../podcastTts.js';
import type { ScriptSegment } from '../podcastScript.js';

function syntheticPcm({ speechSec = 1, silenceSec = 1, rate = RATE }: { speechSec?: number; silenceSec?: number; rate?: number }): Buffer {
  const speech = Buffer.alloc(Math.floor(rate * speechSec) * 2);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE((i % 4 === 0) ? 8000 : -8000, i);
  return Buffer.concat([speech, Buffer.alloc(Math.floor(rate * silenceSec) * 2)]);
}

interface CapturedRequest {
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: {
    responseModalities: string[];
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
      multiSpeakerVoiceConfig?: unknown;
    };
  };
}

function mockFetch(pcm: Buffer): { fetchFn: TtsFetchLike; calls: CapturedRequest[]; urls: string[] } {
  const calls: CapturedRequest[] = [];
  const urls: string[] = [];
  const fetchFn: TtsFetchLike = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.input || body.generationConfig?.responseModalities) {
      urls.push(url);
      calls.push(body as CapturedRequest);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64') } }] } }],
        steps: [{ content: [{ type: 'audio', data: pcmToWav(pcm).toString('base64') }] }],
        usage: { input_tokens: 10, output_tokens: 100 },
      }),
      text: async () => '',
    };
  };
  return { fetchFn, calls, urls };
}

function sentBody(call: any): string {
  return call?.input ? call.input[0].content[0].text : call.contents[0].parts[0].text;
}

function spokenText(call: any): string {
  const t = sentBody(call);
  return t.startsWith(`${STYLE_PROMPT}\n\n`) ? t.slice(STYLE_PROMPT.length + 2) : t;
}

const LEGACY_TTS = 'gemini-2.5-pro-preview-tts';
const DEFAULT_TTS = 'gemini-3.8-flash-tts';

function useTtsModel(model: string | undefined): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.DIGEST_TTS_MODEL;
    if (model === undefined) delete process.env.DIGEST_TTS_MODEL;
    else process.env.DIGEST_TTS_MODEL = model;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DIGEST_TTS_MODEL;
    else process.env.DIGEST_TTS_MODEL = saved;
  });
}

describe('声の割り当て', () => {
  it('既定の声は A が Kore、B が Charon', () => {
    const v = voiceMap();
    expect(v.A).toBe('Kore');
    expect(v.B).toBe('Charon');
  });
});

describe('読み上げ用の文の整え方', () => {
  it('かぎ括弧や三点リーダを取り除く', () => {
    expect(cleanForTts('「新製品」…と『記者会見』')).toBe('新製品、と記者会見');
  });
});

describe('最後の別れの挨拶を取り除く', () => {
  it('台本の終わりにある別れの挨拶だけを取り除く', () => {
    expect(stripTrailingFarewell('詳しくは記事の本文で。それでは、また次回お会いしましょう。')).toBe('詳しくは記事の本文で。');
    expect(stripTrailingFarewell('今日の話題は以上です。それではまた。')).toBe('今日の話題は以上です。');
    expect(stripTrailingFarewell('ここで振り返ります。それでは、また次回。お会いしましょう。')).toBe('ここで振り返ります。');
    expect(stripTrailingFarewell('次回の新製品発表が一番の注目点です。')).toBe('次回の新製品発表が一番の注目点です。');
    expect(stripTrailingFarewell('それでは、次回もお楽しみに。')).toBe('');
  });
});

describe('1つの発言を1人の声で読ませる依頼', () => {
  it('送る文は読み方の指示と空行と発言で、話者の名前は入れない', () => {
    const req = buildUtteranceRequest({ speaker: 'A', text: 'おはようございます' }) as CapturedRequest;
    expect(req.contents[0].parts[0].text).toBe(`${STYLE_PROMPT}\n\nおはようございます`);
    expect(req.generationConfig.responseModalities).toEqual(['AUDIO']);
  });

  it('指示文は声の調子と台本どおりに読むことだけを伝え、話者の名前は書かない', () => {
    expect(STYLE_PROMPT).toBe(
      '次の日本語のセリフを、日本のビジネス系ラジオ番組の出演者のように、落ち着いた知的なトーンで読み上げてください。'
      + '書かれているセリフだけを読み、台本に無い言葉（挨拶・相槌・繰り返しなど）を付け加えないでください。',
    );
    expect(STYLE_PROMPT).not.toContain('\n');
  });

  it('話者は声の指定だけで分け、複数話者の設定は使わない', () => {
    const a = buildUtteranceRequest({ speaker: 'A', text: 'あ' }) as CapturedRequest;
    const b = buildUtteranceRequest({ speaker: 'B', text: 'い' }) as CapturedRequest;
    expect(a.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(b.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Charon');
    expect(a.generationConfig.speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
  });

  it('発言の飾りの記号も取り除く', () => {
    const req = buildUtteranceRequest({ speaker: 'A', text: '「新製品」…と『記者会見』' }) as CapturedRequest;
    expect(req.contents[0].parts[0].text).toBe(`${STYLE_PROMPT}\n\n新製品、と記者会見`);
  });
});

describe('音声データの処理', () => {
  it('末尾の無音の長さを見つける', () => {
    const pcm = syntheticPcm({ speechSec: 1, silenceSec: 1 });
    const silence = trailingSilenceBytes(pcm);
    expect(Math.abs(silence - RATE * 2)).toBeLessThan(RATE * 2 * 0.05);
  });

  it('最後の短い音の区切りを切り落とす', () => {
    const main = syntheticPcm({ speechSec: 3, silenceSec: 0 });
    const gap = Buffer.alloc(Math.floor(RATE * 0.4) * 2);
    const sentinel = syntheticPcm({ speechSec: 1, silenceSec: 0 });
    const tail = Buffer.alloc(RATE * 2 * 2);
    const pcm = Buffer.concat([main, gap, sentinel, tail]);
    const keep = closeCutBytes(pcm);
    expect(keep).toBeLessThanOrEqual(main.length + gap.length);
    expect(keep).toBeGreaterThanOrEqual(main.length * 0.95);
  });

  it('正しい WAV のヘッダーを作る', () => {
    const wav = pcmToWav(Buffer.alloc(1000));
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt32LE(40)).toBe(1000);
  });
});

describe('台本全体の音声合成', () => {
  useTtsModel(undefined);

  it('発言ごとに合成し、音声と長さを返す', async () => {
    const { fetchFn, calls, urls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    const result = await synthesizeScript(
      [{ speaker: 'A', text: 'おはようございます' }, { speaker: 'B', text: '今日の話題です' }],
      { apiKey: 'dummy', fetchFn },
    );
    expect(calls).toHaveLength(3);
    expect(urls[0]).toMatch(/\/v1beta\/interactions$/);
    expect((calls[0] as any).model).toBe(DEFAULT_TTS);
    const text = sentBody(calls[calls.length - 1]);
    expect(text).toContain('失礼いたします');
    expect(result.buffer.length).toBeGreaterThan(1000);
    expect(['mp3', 'wav']).toContain(result.ext);
    expect(['audio/mpeg', 'audio/wav']).toContain(result.mimeType);
    expect(result.durationSec).toBeGreaterThan(0);
  });

  it('台本の最後の別れの挨拶を取り除き、自動で付ける締めと重ねない', async () => {
    const { fetchFn, calls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    await synthesizeScript(
      [{ speaker: 'A', text: '今日の話題は以上です。それでは、また次回お会いしましょう。' }],
      { apiKey: 'dummy', fetchFn },
    );
    const bodies = calls.map((c) => spokenText(c));
    expect(bodies.join('\n').match(/お会いしましょう/g) ?? []).toHaveLength(1);
    expect(bodies[0]).toContain('今日の話題は以上です');
  });

  it('API キーが無ければエラーを投げる', async () => {
    await expect(synthesizeScript([{ speaker: 'A', text: 'x' }], { apiKey: undefined })).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('400 番台のエラーは問い直さずにすぐ失敗する', async () => {
    let calls = 0;
    const fetchFn: TtsFetchLike = async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad request' };
    };
    await expect(
      synthesizeScript([{ speaker: 'A', text: 'x' }], { apiKey: 'dummy', fetchFn }),
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('同じ話者の発言をまとめる', () => {
  it('続けて話す同じ話者の発言を1つにまとめる', () => {
    expect(mergeAdjacentSpeakers([
      { speaker: 'A', text: '一つ目の話です。' },
      { speaker: 'A', text: '続きの話です。' },
      { speaker: 'B', text: 'そうなんですね。' },
    ])).toEqual([
      { speaker: 'A', text: '一つ目の話です。 続きの話です。' },
      { speaker: 'B', text: 'そうなんですね。' },
    ]);
  });

  it('話者が交互なら何も変えない', () => {
    const segs: ScriptSegment[] = [{ speaker: 'A', text: 'あ' }, { speaker: 'B', text: 'い' }];
    expect(mergeAdjacentSpeakers(segs)).toEqual(segs);
  });

  it('まとめると長さの上限を超えるときは分けたままにする', () => {
    const long = 'あ'.repeat(300);
    const merged = mergeAdjacentSpeakers([
      { speaker: 'A', text: long },
      { speaker: 'A', text: long },
    ], CHUNK_CHARS);
    expect(merged).toHaveLength(2);
    expect(merged.every((s) => s.text.length <= CHUNK_CHARS)).toBe(true);
  });

  it('入力の配列も中身も書き換えない', () => {
    const segs: ScriptSegment[] = [{ speaker: 'A', text: 'あ' }, { speaker: 'A', text: 'い' }];
    mergeAdjacentSpeakers(segs);
    expect(segs).toEqual([{ speaker: 'A', text: 'あ' }, { speaker: 'A', text: 'い' }]);
  });
});

describe.each([LEGACY_TTS, DEFAULT_TTS])('話者の名前を音声合成に送らない [%s]', (model) => {
  useTtsModel(model);

  it('行頭に話者名とコロンを付けて送らない', async () => {
    const { fetchFn, calls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    await synthesizeScript([
      { speaker: 'A', text: '最初の話題です。' },
      { speaker: 'B', text: 'お願いします。' },
    ], { apiKey: 'dummy', fetchFn });
    for (const call of calls) {
      expect(sentBody(call)).not.toMatch(/^[^\n]{1,10}: /);
    }
  });

  it('1回の依頼で送るのは1つの発言だけ', async () => {
    const { fetchFn, calls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    await synthesizeScript([
      { speaker: 'A', text: '最初の話題です。' },
      { speaker: 'B', text: 'お願いします。' },
      { speaker: 'A', text: '次の話題です。' },
    ], { apiKey: 'dummy', fetchFn });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(spokenText(call)).not.toContain('\n');
      if (model === LEGACY_TTS) {
        expect(sentBody(call).startsWith(`${STYLE_PROMPT}\n\n`)).toBe(true);
      } else {
        expect(sentBody(call)).not.toContain(STYLE_PROMPT);
        expect((call as any).input[0].content[0].annotations[0].style).toBe(STYLE_PROMPT);
      }
    }
  });

  it('締めの言葉と区切りの音は1つの発言として最後に送る', async () => {
    const { fetchFn, calls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    await synthesizeScript([
      { speaker: 'A', text: '詳しくは記事でご確認ください。' },
    ], { apiKey: 'dummy', fetchFn });
    const last = sentBody(calls[calls.length - 1]);
    expect(last).toContain('また次回お会いしましょう');
    expect(last).toContain('失礼いたします');
    expect(calls.filter((c) => sentBody(c).includes('失礼いたします'))).toHaveLength(1);
  });
});

describe('発言をつなぐときの無音の詰め方', () => {
  it('2つ目からの発言は先頭の無音を詰める', () => {
    const lead = Buffer.alloc(Math.floor(RATE * 0.5) * 2);
    const pcm = Buffer.concat([lead, syntheticPcm({ speechSec: 1, silenceSec: 0 })]);
    const trimmed = trimForJoin(pcm, { isFirst: false });
    const remainingLead = leadingSilenceBytes(trimmed);
    expect(remainingLead).toBeLessThan(Math.floor(RATE * 0.15) * 2);
    expect(trimmed.length).toBeLessThan(pcm.length);
  });

  it('最初の発言の先頭の無音は詰めない', () => {
    const lead = Buffer.alloc(Math.floor(RATE * 0.5) * 2);
    const pcm = Buffer.concat([lead, syntheticPcm({ speechSec: 1, silenceSec: 0 })]);
    const trimmed = trimForJoin(pcm, { isFirst: true });
    expect(leadingSilenceBytes(trimmed)).toBe(lead.length);
  });

  it('末尾の無音は少しだけ残す', () => {
    const pcm = syntheticPcm({ speechSec: 1, silenceSec: 1 });
    const trimmed = trimForJoin(pcm, { isFirst: true });
    const tail = trailingSilenceBytes(trimmed);
    expect(tail).toBeGreaterThan(Math.floor(RATE * 0.15) * 2);
    expect(tail).toBeLessThan(Math.floor(RATE * 0.35) * 2);
  });
});

describe('月の読み方の置き換え', () => {
  it('読み方が分かれる3つの月をかなに置き換える', () => {
    expect(cleanForTts('4月の新製品')).toBe('しがつの新製品');
    expect(cleanForTts('7月の運動会')).toBe('しちがつの運動会');
    expect(cleanForTts('9月の値上げ')).toBe('くがつの値上げ');
  });

  it('読み方が一つに決まる月は数字のまま残す', () => {
    expect(cleanForTts('1月か10月か12月')).toBe('1月か10月か12月');
  });

  it('すぐ前が数字なら月の名前として扱わない', () => {
    expect(cleanForTts('24月分の会費')).toBe('24月分の会費');
    expect(cleanForTts('１４月分の料金')).toBe('１４月分の料金');
  });

  it('すぐ後ろが「曜」なら曜日として扱う', () => {
    expect(cleanForTts('第4月曜日に集まる')).toBe('第4月曜日に集まる');
    expect(cleanForTts('9月曜日')).toBe('9月曜日');
  });

  it('1つの文にいくつあってもすべて置き換える', () => {
    expect(cleanForTts('4月から9月までの期間')).toBe('しがつからくがつまでの期間');
  });
});

describe('中黒を取り除く', () => {
  it('番組の名前の中黒を取り除く', () => {
    expect(cleanForTts('サンプル・ラジオです')).toBe('サンプルラジオです');
  });

  it('話題の名前を並べた文の中黒を取り除く', () => {
    expect(cleanForTts('今日は家電・暮らし、科学・宇宙、地域・行事の三つの話題から'))
      .toBe('今日は家電暮らし、科学宇宙、地域行事の三つの話題から');
  });

  it('中黒は読点に置き換えない', () => {
    const out = cleanForTts('家電・暮らし、天気');
    expect(out).toBe('家電暮らし、天気');
    expect(out.split('、')).toHaveLength(2);
  });

  it('人の名前の中黒も取り除く', () => {
    expect(cleanForTts('ジョン・ドランケ大統領')).toBe('ジョンドランケ大統領');
  });
});

describe('モデルの名前で呼び出し方を決める', () => {
  it('3 で始まる版は新しい呼び出し方を使う', () => {
    expect(usesInteractionsApi('gemini-3.8-flash-tts')).toBe(true);
    expect(usesInteractionsApi('gemini-3.1-flash-tts')).toBe(true);
  });

  it('古い版は従来の呼び出し方を使う', () => {
    expect(usesInteractionsApi('gemini-2.5-pro-preview-tts')).toBe(false);
    expect(usesInteractionsApi('gemini-2.5-flash-preview-tts')).toBe(false);
  });
});

describe('新しい呼び出し方の依頼', () => {
  const seg: ScriptSegment = { speaker: 'A', text: 'ためしの発言です。' };

  it('読み方の指示を本文に混ぜず、別の欄で渡す', () => {
    const body = buildInteractionsRequest(seg, { voices: { A: 'Kore', B: 'Charon' } }) as any;
    const content = body.input[0].content[0];
    expect(content.text).toBe('ためしの発言です。');
    expect(content.text).not.toContain(STYLE_PROMPT);
    expect(content.annotations[0]).toEqual({ type: 'speech_metadata', style: STYLE_PROMPT });
  });

  it('本文は読み上げ用に整えてから渡す', () => {
    const body = buildInteractionsRequest(
      { speaker: 'A', text: '「サンプル・ラジオ」です。' },
      { voices: { A: 'Kore', B: 'Charon' } },
    ) as any;
    expect(body.input[0].content[0].text).toBe('サンプルラジオです。');
  });

  it('話者の名前は渡さず、声だけで分ける', () => {
    const body = buildInteractionsRequest({ speaker: 'B', text: 'お願いします。' }, { voices: { A: 'Kore', B: 'Charon' } }) as any;
    expect(JSON.stringify(body)).not.toContain('speaker');
    expect(body.generation_config.speech_config[0].voice).toBe('Charon');
  });

  it('音声で返すよう指定する', () => {
    const body = buildInteractionsRequest(seg) as any;
    expect(body.response_format).toEqual({ type: 'audio' });
  });
});

describe('新しい呼び出し方の答えから音声を取り出す', () => {
  it('steps の中の audio から取り出す', () => {
    const json = { steps: [{ content: [{ type: 'text', text: 'x' }, { type: 'audio', data: 'QUJD' }] }] };
    expect(extractInteractionsAudio(json)).toBe('QUJD');
  });

  it('output_audio の形でも取り出す', () => {
    expect(extractInteractionsAudio({ output_audio: { data: 'QUJD' } })).toBe('QUJD');
  });

  it('見つからないときは、答えにあったキーを添えてエラーを投げる', () => {
    expect(() => extractInteractionsAudio({ foo: 1, bar: 2 })).toThrow(/foo, bar/);
  });
});

describe('WAV から中身の音声を取り出す', () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

  it('WAV のヘッダーを外して中身だけを返す', () => {
    expect(pcmFromWav(pcmToWav(pcm))).toEqual(pcm);
  });

  it('ヘッダーの無い音声はそのまま返す', () => {
    expect(pcmFromWav(pcm)).toEqual(pcm);
  });

  it('data の前に別のかたまりがあっても正しく見つける', () => {
    const wav = pcmToWav(pcm);
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0);
    list.writeUInt32LE(4, 4);
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    expect(pcmFromWav(withList)).toEqual(pcm);
  });
});

describe('読み間違えやすい「名前と役職」を拾う', () => {
  it('役職の付いた名前を拾う', () => {
    expect(extractTitledNames('森野首相は会見で述べた')).toEqual([{ name: '森野', title: '首相' }]);
    expect(extractTitledNames('ドランケ大統領が発表')).toEqual([{ name: 'ドランケ', title: '大統領' }]);
  });

  it('同じ組み合わせは1回だけ返す', () => {
    expect(extractTitledNames('森野首相は…。森野首相はまた…')).toHaveLength(1);
  });

  it('役職が無ければ拾わない', () => {
    expect(extractTitledNames('あしたは雨が降りそうです')).toEqual([]);
  });

  it('漢字とカタカナが続いていても、名前はどちらか一方だけにする', () => {
    expect(extractTitledNames('隣国ドランケ大統領が')).toEqual([{ name: 'ドランケ', title: '大統領' }]);
  });

  it('役職の前の「前」や「元」を名前に含めない', () => {
    expect(extractTitledNames('川上前首相は')).toEqual([{ name: '川上', title: '前首相' }]);
    expect(extractTitledNames('大森一郎前首相')).toEqual([{ name: '大森一郎', title: '前首相' }]);
  });

  it('長音を含むカタカナの名前も拾う', () => {
    expect(extractTitledNames('ローデンバーグ大統領')).toEqual([{ name: 'ローデンバーグ', title: '大統領' }]);
  });

  it('役職の前にある人の名前でない言葉は拾わない', () => {
    expect(extractTitledNames('サンプル社の上級副社長は')).toEqual([]);
    expect(extractTitledNames('同社社長によると')).toEqual([]);
    expect(extractTitledNames('代表取締役社長が')).toEqual([]);
    expect(extractTitledNames('筆頭副社長は')).toEqual([]);
  });

  it('人の名前でない言葉を除いても、本当の名前は拾う', () => {
    expect(extractTitledNames('サンプル電機の田中一郎社長は')).toEqual([{ name: '田中一郎', title: '社長' }]);
  });

  it('役職を表す言葉の一部を含む語や「兼」で終わる語は拾わない', () => {
    expect(extractTitledNames('共同創業者兼CEOのAlex Sampleは')).toEqual([]);
    expect(extractTitledNames('創業者兼会長は')).toEqual([]);
    expect(extractTitledNames('執行役員社長が')).toEqual([]);
    expect(extractTitledNames('最高経営責任者兼社長が')).toEqual([]);
    expect(extractTitledNames('研究所長兼社長は')).toEqual([]);
  });

  it('省庁や役職の名前の一部を含む語は拾わない', () => {
    expect(extractTitledNames('北の国の科学・産業大臣は')).toEqual([]);
    expect(extractTitledNames('経済産業大臣は')).toEqual([]);
    expect(extractTitledNames('国家安全保障長官が')).toEqual([]);
  });

  it('官房長官の前の名前は、名前だけを拾う', () => {
    expect(extractTitledNames('中西官房長官は')).toEqual([{ name: '中西', title: '官房長官' }]);
  });

  it('カタカナや英字の名前のすぐ後ろの漢字は、長官や大臣の省の名前として拾わない', () => {
    expect(extractTitledNames('ペトロワ司法長官は')).toEqual([]);
    expect(extractTitledNames('ミルナー陸軍長官は')).toEqual([]);
    expect(extractTitledNames('Sample内務大臣が')).toEqual([]);
  });

  it('この扱いは長官と大臣だけで、会社名のすぐ後ろの名前と会長は拾う', () => {
    expect(extractTitledNames('サンプルグループ山田太郎会長は')).toEqual([{ name: '山田太郎', title: '会長' }]);
  });

  it('ひらがなや句読点の後ろの閣僚の名前は拾う', () => {
    expect(extractTitledNames('政府の中西官房長官は')).toEqual([{ name: '中西', title: '官房長官' }]);
    expect(extractTitledNames('、北村大臣は')).toEqual([{ name: '北村', title: '大臣' }]);
  });

  it('国の省の名前も拾わない', () => {
    expect(extractTitledNames('隣国の国防長官は')).toEqual([]);
  });

  it('一部の文字が除く言葉と同じでも、名前なら拾う', () => {
    expect(extractTitledNames('兼田社長は')).toEqual([{ name: '兼田', title: '社長' }]);
    expect(extractTitledNames('長尾首相は')).toEqual([{ name: '長尾', title: '首相' }]);
    expect(extractTitledNames('鈴木健一郎社長兼CEOは')).toEqual([{ name: '鈴木健一郎', title: '社長' }]);
  });

  it('役職が直接付かない形は拾えない', () => {
    expect(extractTitledNames('森野氏が首相就任後')).toEqual([]);
  });
});

describe('使う音声合成モデルの決め方', () => {
  describe('環境変数が無いとき', () => {
    useTtsModel(undefined);
    it('既定のモデルを使う', () => {
      expect(getTtsModel()).toBe(DEFAULT_TTS);
    });
  });

  describe('環境変数で古い版を選んだとき', () => {
    useTtsModel(LEGACY_TTS);
    it('環境変数で古い版に戻せる', () => {
      expect(getTtsModel()).toBe(LEGACY_TTS);
    });

    it('古い版に戻すと従来の呼び出し方で呼ぶ', async () => {
      const { fetchFn, urls } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
      await synthesizeScript([{ speaker: 'A', text: 'こんにちは' }], { apiKey: 'dummy', fetchFn });
      expect(urls[0]).toContain(`${LEGACY_TTS}:generateContent`);
    });
  });
});

describe('読みの照合結果のまとめ', () => {
  const ok = (misread: number = 0): ReadingCheckResult => ({
    target: true, checked: true, misread: Array.from({ length: misread }, () => ({ name: 'X', title: '首相' })),
  });
  const failed = (error: string): ReadingCheckResult => ({ target: true, checked: false, misread: [], error });
  const notTarget: ReadingCheckResult = { target: false, checked: false, misread: [] };

  it('照合できた件数と警告の件数を並べて出す', () => {
    const { line, allFailed } = summarizeReadingChecks([ok(), ok(1), notTarget]);
    expect(line).toContain('対象2発言');
    expect(line).toContain('照合2件');
    expect(line).toContain('警告1件');
    expect(allFailed).toBe(false);
  });

  it('照合できなかった件数と理由を出す', () => {
    const { line } = summarizeReadingChecks([ok(), failed('HTTP 404 model not found')]);
    expect(line).toContain('照合できず1件');
    expect(line).toContain('HTTP 404 model not found');
  });

  it('対象があるのに1件も照合できなければ allFailed にする', () => {
    expect(summarizeReadingChecks([failed('HTTP 404'), failed('HTTP 404')]).allFailed).toBe(true);
  });

  it('対象が無いときは allFailed にしない', () => {
    expect(summarizeReadingChecks([notTarget, notTarget]).allFailed).toBe(false);
  });
});

describe('1つの発言の読みの照合', () => {
  const pcm = syntheticPcm({ speechSec: 1, silenceSec: 0 });

  it('名前と役職が無い発言は照合しない', async () => {
    const r = await checkUtteranceReading('あさっては曇りです', pcm, { apiKey: 'k' });
    expect(r).toEqual({ target: false, checked: false, misread: [] });
  });

  it('照合の呼び出しが失敗したら、checked を false にして理由を返す', async () => {
    const fetchFn: TtsFetchLike = async () =>
      ({ ok: false, status: 404, json: async () => ({}), text: async () => 'model not found' });
    const r = await checkUtteranceReading('森野首相は述べた', pcm, {
      apiKey: 'k', fetchFn, readings: new Map([['森野', 'もりの']]),
    });
    expect(r.target).toBe(true);
    expect(r.checked).toBe(false);
    expect(r.error).toContain('404');
  });

  const transcribes = (text: string): TtsFetchLike => async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => '',
  });

  it('読みで比べて、別の名前に置き換わったものを見つける', async () => {
    const r = await checkUtteranceReading('森野首相は述べた', pcm, {
      apiKey: 'k', fetchFn: transcribes('かわかみしゅしょうはのべた'), readings: new Map([['森野', 'もりの']]),
    });
    expect(r.checked).toBe(true);
    expect(r.misread).toEqual([{ name: '森野', title: '首相' }]);
  });

  it('正しく読まれていれば、書き起こしの文字が違っても警告しない', async () => {
    const r = await checkUtteranceReading('サンプル工業の大西健司社長は', pcm, {
      apiKey: 'k', fetchFn: transcribes('さんぷるこうぎょうのおおにしけんじしゃちょうは'), readings: new Map([['大西健司', 'おおにしけんじ']]),
    });
    expect(r.checked).toBe(true);
    expect(r.misread).toEqual([]);
  });

  it('読みが1つも無ければ、書き起こしを呼ばずに照合できずとする', async () => {
    let called = 0;
    const fetchFn: TtsFetchLike = async () => { called++; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
    const r = await checkUtteranceReading('森野首相は述べた', pcm, { apiKey: 'k', fetchFn, readings: new Map() });
    expect(called).toBe(0);
    expect(r).toMatchObject({ target: true, checked: false, misread: [], unresolved: 1 });
  });

  it('書き起こしはひらがなで出させる', async () => {
    let prompt = '';
    const fetchFn: TtsFetchLike = async (_u, init) => {
      prompt = JSON.parse(init.body).contents[0].parts[0].text;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'もりの' }] } }] }), text: async () => '' };
    };
    await checkUtteranceReading('森野首相は', pcm, { apiKey: 'k', fetchFn, readings: new Map([['森野', 'もりの']]) });
    expect(prompt).toContain('すべてひらがなで');
  });
});

describe('利用量が読めないときに知らせる', () => {
  useTtsModel(DEFAULT_TTS);

  it('音声が返ったのに利用量が0なら、答えのキーを添えてエラーを記録する', async () => {
    const pcm = syntheticPcm({ speechSec: 2, silenceSec: 0 });
    const fetchFn: TtsFetchLike = async () => ({
      ok: true, status: 200,
      json: async () => ({ steps: [{ content: [{ type: 'audio', data: pcmToWav(pcm).toString('base64') }] }], billing: {} }),
      text: async () => '',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await synthesizeScript([{ speaker: 'A', text: 'こんにちは' }], { apiKey: 'dummy', fetchFn });
      const msgs = spy.mock.calls.map((c) => String(c[0]));
      const hit = msgs.find((m) => m.includes('利用量を読み取れませんでした'));
      expect(hit, msgs.join('\n')).toBeDefined();
      expect(hit).toContain('steps, billing');
    } finally {
      spy.mockRestore();
    }
  });

  it('利用量が読めれば警告しない', async () => {
    const { fetchFn } = mockFetch(syntheticPcm({ speechSec: 2, silenceSec: 0 }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await synthesizeScript([{ speaker: 'A', text: 'こんにちは' }], { apiKey: 'dummy', fetchFn });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('利用量を読み取れませんでした'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('かなの整え方と名前の読み', () => {
  it('カタカナをひらがなにし、空白と長音と記号を取り除く', () => {
    expect(normalizeKana('ドランケ だいとうりょう、')).toBe('どらんけだいとうりょう');
    expect(normalizeKana('ローデンバーグ')).toBe('ろでんばぐ');
  });

  it('カタカナの名前は調べずにそのまま読みにする', () => {
    expect(readingOfName('ドランケ', new Map())).toBe('どらんけ');
  });

  it('漢字の名前は調べた読みを使う', () => {
    expect(readingOfName('森野', new Map([['森野', 'もりの']]))).toBe('もりの');
  });

  it('読みが無ければ undefined を返す', () => {
    expect(readingOfName('森野', new Map())).toBeUndefined();
  });
});

describe('読みで読み間違いを見つける', () => {
  const names = [{ name: '森野', title: '首相' }, { name: 'ドランケ', title: '大統領' }];

  it('読みが書き起こしに無ければ読み間違いとする', () => {
    const r = findMisreadByReading(names, new Map([['森野', 'もりの']]), 'かわかみしゅしょうとどらんけだいとうりょう');
    expect(r.misread).toEqual([{ name: '森野', title: '首相' }]);
  });

  it('読みが無い名前は unresolved に入れ、読み間違いには数えない', () => {
    const r = findMisreadByReading(names, new Map(), 'どらんけだいとうりょう');
    expect(r.misread).toEqual([]);
    expect(r.unresolved).toEqual([{ name: '森野', title: '首相' }]);
  });

  it('書き起こしにカタカナが混じっていても比べられる', () => {
    const r = findMisreadByReading(names, new Map([['森野', 'もりの']]), 'もりの首相とドランケ大統領');
    expect(r.misread).toEqual([]);
  });
});

describe('名前の読みをまとめて調べる', () => {
  const answers = (text: string, onCall?: (body: any) => void): TtsFetchLike => async (_u, init) => {
    onCall?.(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => '' };
  };

  it('読みの表を返す', async () => {
    const r = await lookupNameReadings(['森野', '大西健司'], {
      apiKey: 'k', fetchFn: answers('{"森野": "もりの", "大西健司": "おおにしけんじ"}'),
    });
    expect(r.readings.get('森野')).toBe('もりの');
    expect(r.readings.get('大西健司')).toBe('おおにしけんじ');
    expect(r.error).toBeUndefined();
  });

  it('カタカナの名前は調べない', async () => {
    let asked = '';
    await lookupNameReadings(['ドランケ', '森野'], { apiKey: 'k', fetchFn: answers('{}', (b) => { asked = b.contents[0].parts[0].text; }) });
    expect(asked).toContain('森野');
    expect(asked).not.toContain('ドランケ');
  });

  it('カタカナの名前だけなら呼び出さない', async () => {
    let called = 0;
    await lookupNameReadings(['ドランケ'], { apiKey: 'k', fetchFn: answers('{}', () => { called++; }) });
    expect(called).toBe(0);
  });

  it('音声は渡さず名前の文字だけを渡す', async () => {
    let parts: any[] = [];
    await lookupNameReadings(['森野'], { apiKey: 'k', fetchFn: answers('{}', (b) => { parts = b.contents[0].parts; }) });
    expect(parts.some((p) => p.inlineData)).toBe(false);
  });

  it('自信の無い名前は空で答えさせ、空は表に入れない', async () => {
    const r = await lookupNameReadings(['森野', '幻田'], { apiKey: 'k', fetchFn: answers('{"森野": "もりの", "幻田": ""}') });
    expect(r.readings.has('幻田')).toBe(false);
    expect(r.missing).toEqual(['幻田']);
  });

  it('失敗したら空の表を返す', async () => {
    const fetchFn: TtsFetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    expect((await lookupNameReadings(['森野'], { apiKey: 'k', fetchFn })).readings.size).toBe(0);
  });

  it('呼び出しが失敗したら、理由と名前を返す', async () => {
    const fetchFn: TtsFetchLike = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'model not found' });
    const r = await lookupNameReadings(['森野'], { apiKey: 'k', fetchFn });
    expect(r.error).toContain('HTTP 404');
    expect(r.error).toContain('model not found');
    expect(r.missing).toEqual(['森野']);
  });

  it('答えの形が崩れていたら、そう返す', async () => {
    const r = await lookupNameReadings(['森野'], { apiKey: 'k', fetchFn: answers('ごめんなさい、答えられません') });
    expect(r.error).toContain('答えの形が崩れた');
    expect(r.error).toContain('ごめんなさい');
  });

  it('空の答えは失敗ではなく、missing に入れる', async () => {
    const r = await lookupNameReadings(['森野'], { apiKey: 'k', fetchFn: answers('{"森野": ""}') });
    expect(r.error).toBeUndefined();
    expect(r.missing).toEqual(['森野']);
  });
});

describe('読みが分からない名前も数える', () => {
  it('読みが分からない名前の数を出す', () => {
    const { line } = summarizeReadingChecks([
      { target: true, checked: true, misread: [], unresolved: 2 },
    ]);
    expect(line).toContain('読み不明の名前2件');
  });
});

describe('名前の読みを調べた結果の記録', () => {
  it('調べる名前が無ければ何も出さない', () => {
    expect(formatNameReadingLog({ asked: [], readings: new Map(), missing: [] })).toBeNull();
  });

  it('取れた件数と取れなかった名前と呼び出しの失敗を1行に出す', () => {
    const r = formatNameReadingLog({
      asked: ['森野', '大西健司'], readings: new Map([['森野', 'もりの']]), missing: ['大西健司'],
    })!;
    expect(r.line).toContain('調べた2件 → 取得1件');
    expect(r.line).toContain('取れず1件（大西健司）');
    expect(r.noneObtained).toBe(false);
  });

  it('1件も取れなければ noneObtained にする', () => {
    const r = formatNameReadingLog({ asked: ['森野'], readings: new Map(), missing: ['森野'], error: 'HTTP 404' })!;
    expect(r.line).toContain('呼び出し失敗（HTTP 404）');
    expect(r.noneObtained).toBe(true);
  });
});

describe('読みが取れなかった理由を照合結果に入れる', () => {
  const pcm = syntheticPcm({ speechSec: 1, silenceSec: 0 });

  it('読みを調べる呼び出しが失敗していたら、その理由を入れる', async () => {
    const r = await checkUtteranceReading('森野首相は述べた', pcm, { apiKey: 'k', readings: new Map(), readingsError: 'HTTP 404' });
    expect(r.error).toContain('HTTP 404');
  });

  it('読みが返らなかっただけなら、その名前を入れる', async () => {
    const r = await checkUtteranceReading('森野首相は述べた', pcm, { apiKey: 'k', readings: new Map() });
    expect(r.error).toContain('AIが読みを返さなかった: 森野');
  });
});

describe('姓だけで読まれても置き換えとみなさない', () => {
  const names = [{ name: '森野花子', title: '首相' }];
  const readings = new Map([['森野花子', 'もりの はなこ']]);

  it('空白で分かれた読みから姓の読みを取る', () => {
    expect(familyReadingOf('森野花子', readings)).toBe('もりの');
    expect(familyReadingOf('森野', new Map([['森野', 'もりの']]))).toBeUndefined();
    expect(familyReadingOf('ドランケ', new Map())).toBeUndefined();
  });

  it('姓だけで読まれたら警告しない', () => {
    expect(findMisreadByReading(names, readings, 'もりのしゅしょうはあたらしいほうあんについて').misread).toEqual([]);
  });

  it('姓と名の両方で読まれても警告しない', () => {
    expect(findMisreadByReading(names, readings, 'もりのはなこしゅしょうは').misread).toEqual([]);
  });

  it('姓ごと別の人に置き換わっていたら警告する', () => {
    expect(findMisreadByReading(names, readings, 'かわかみしゅしょうは').misread).toEqual(names);
  });

  it('読みを調べるとき、姓と名を空白で分けるよう頼む', async () => {
    let asked = '';
    const fetchFn = (async (_u: string, init: { body: string }) => {
      asked = JSON.parse(init.body).contents[0].parts[0].text;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), text: async () => '' };
    }) as never;
    await lookupNameReadings(['森野花子'], { apiKey: 'k', fetchFn });
    expect(asked).toContain('姓と名の間に半角スペース');
  });
});

describe('読み間違いの警告の文', () => {
  it('探した読みと書き起こしを警告に添える', () => {
    const line = formatMisreadWarning(
      { name: '森野花子', title: '首相' }, new Map([['森野花子', 'もりの はなこ']]), 'かわかみしゅしょうは',
    );
    expect(line).toContain('台本の「森野花子首相」が音声で確認できません');
    expect(line).toContain('探した読み: もりの はなこ');
    expect(line).toContain('書き起こし: かわかみしゅしょうは');
  });
});
