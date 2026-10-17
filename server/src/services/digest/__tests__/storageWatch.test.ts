import { describe, it, expect } from 'vitest';
import {
  decideStorageWarn, humanBytes, storageWarnMail, type StorageReport,
} from '../storageWatch.js';

const report = (over: Partial<StorageReport> = {}): StorageReport => ({
  databaseBytes: 7 * 1024 ** 3,
  tables: [
    { table: 'sample_audio', label: 'サンプルの音声データ', bytes: 4 * 1024 ** 3, rows: 400 },
    { table: 'sample_images', label: 'サンプルの画像データ', bytes: 2 * 1024 ** 3, rows: 1200 },
    { table: 'sample_attachments', label: 'サンプルの添付ファイル', bytes: 0, rows: 0 },
  ],
  podcastAudioBytes: 4 * 1024 ** 3,
  podcastAudioCount: 400,
  warnBytes: 8 * 1024 ** 3,
  usedRatio: 7 / 8,
  retentionDays: 180,
  ...over,
});

describe('decideStorageWarn', () => {
  it('使用率がしきい値より低ければ知らせない', () => {
    const d = decideStorageWarn({ usedRatio: 0.5, today: '2054-07-30', lastWarnedDate: '' });
    expect(d.warn).toBe(false);
    expect(d.reason).toBe('空き十分');
  });

  it('使用率がしきい値と同じか高ければ知らせる', () => {
    expect(decideStorageWarn({ usedRatio: 0.8, today: '2054-07-30', lastWarnedDate: '' }).warn).toBe(true);
    expect(decideStorageWarn({ usedRatio: 0.99, today: '2054-07-30', lastWarnedDate: '' }).warn).toBe(true);
  });

  it('知らせるのは1日に1回までで、日付が変われば再び知らせる', () => {
    const first = decideStorageWarn({ usedRatio: 0.9, today: '2054-07-30', lastWarnedDate: '' });
    expect(first.warn).toBe(true);
    expect(first.nextLastWarnedDate).toBe('2054-07-30');

    const again = decideStorageWarn({ usedRatio: 0.9, today: '2054-07-30', lastWarnedDate: '2054-07-30' });
    expect(again.warn).toBe(false);
    expect(again.reason).toBe('本日は送信済み');

    expect(decideStorageWarn({ usedRatio: 0.9, today: '2054-07-31', lastWarnedDate: '2054-07-30' }).warn).toBe(true);
  });

  it('使用率が下がったら送った日の記録を消し、同じ日にまた上がれば知らせる', () => {
    const recovered = decideStorageWarn({ usedRatio: 0.3, today: '2054-07-30', lastWarnedDate: '2054-07-30' });
    expect(recovered.warn).toBe(false);
    expect(recovered.nextLastWarnedDate).toBe('');
    expect(decideStorageWarn({ usedRatio: 0.9, today: '2054-07-30', lastWarnedDate: '' }).warn).toBe(true);
  });

  it('しきい値を引数で指定できる', () => {
    expect(decideStorageWarn({ usedRatio: 0.7, threshold: 0.6, today: 'd', lastWarnedDate: '' }).warn).toBe(true);
    expect(decideStorageWarn({ usedRatio: 0.7, threshold: 0.9, today: 'd', lastWarnedDate: '' }).warn).toBe(false);
  });
});

describe('storageWarnMail', () => {
  it('件名と本文に使用量・保存期間・テーブルごとの内訳が入り、0バイトのテーブルは省く', () => {
    const mail = storageWarnMail(report(), 'https://app.example.com');
    expect(mail.subject).toContain('7.0GB');
    expect(mail.text).toContain('目安の 88%');
    expect(mail.text).toContain('180日を過ぎたものは自動で削除');
    expect(mail.text).toContain('台本は残るので作り直せます');
    expect(mail.text).toContain('サンプルの音声データ: 4.0GB（400行）');
    expect(mail.text).not.toContain('サンプルの添付ファイル');
    expect(mail.html).toContain('https://app.example.com/digest');
  });

  it('本文でバックアップへの影響にも触れる', () => {
    const mail = storageWarnMail(report(), '');
    expect(mail.text).toContain('バックアップの容量と復元にかかる時間');
  });
});

describe('humanBytes', () => {
  it('バイト数を単位つきの読みやすい表記にする', () => {
    expect(humanBytes(0)).toBe('0B');
    expect(humanBytes(1024)).toBe('1.0KB');
    expect(humanBytes(10 * 1024 ** 2)).toBe('10.0MB');
    expect(humanBytes(4 * 1024 ** 3)).toBe('4.0GB');
    expect(humanBytes(null)).toBe('-');
  });
});
