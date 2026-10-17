import { describe, it, expect } from 'vitest';
import {
  frequencyMatches, normalizeSuggestFrequency, sourceSuggestDue,
  REVIEW_DOW, REVIEW_HOUR, SUGGEST_DOM, SUGGEST_DOW, SUGGEST_HOUR,
} from '../scheduler.js';

describe('frequencyMatches', () => {
  it('daily と未指定はすべての曜日で true', () => {
    for (let dow = 0; dow < 7; dow++) {
      expect(frequencyMatches('daily', dow)).toBe(true);
      expect(frequencyMatches(undefined, dow)).toBe(true);
    }
  });
  it('weekly3 は月・水・金曜だけ true', () => {
    expect([0,1,2,3,4,5,6].filter(d => frequencyMatches('weekly3', d))).toEqual([1,3,5]);
  });
  it('weekly1 は月曜だけ true', () => {
    expect([0,1,2,3,4,5,6].filter(d => frequencyMatches('weekly1', d))).toEqual([1]);
  });
});

describe('定期処理の実行時刻', () => {
  it('方針の見直しは日曜の17時', () => {
    expect(REVIEW_DOW).toBe(0);
    expect(REVIEW_HOUR).toBe(17);
  });

  it('情報源の提案は毎月1日の18時', () => {
    expect(SUGGEST_DOM).toBe(1);
    expect(SUGGEST_HOUR).toBe(18);
  });

  it('提案は見直しの開始から10分以上あとに始まる', () => {
    expect((SUGGEST_HOUR - REVIEW_HOUR) * 60).toBeGreaterThanOrEqual(10);
  });
});

describe('情報源の提案の頻度設定', () => {
  it('未指定・空・対応していない値は monthly として読む', () => {
    expect(normalizeSuggestFrequency(undefined)).toBe('monthly');
    expect(normalizeSuggestFrequency('')).toBe('monthly');
    expect(normalizeSuggestFrequency('daily')).toBe('monthly');
    expect(normalizeSuggestFrequency('monthly')).toBe('monthly');
  });

  it('off と weekly はその値のまま読む', () => {
    expect(normalizeSuggestFrequency('off')).toBe('off');
    expect(normalizeSuggestFrequency('weekly')).toBe('weekly');
  });

  it('off ならどの日付・曜日でも実行しない', () => {
    for (let dom = 1; dom <= 31; dom++) {
      for (let dow = 0; dow < 7; dow++) {
        expect(sourceSuggestDue('off', dom, dow)).toBe(false);
      }
    }
  });

  it('monthly なら決められた日付のときだけ実行する', () => {
    expect(sourceSuggestDue('monthly', SUGGEST_DOM, 3)).toBe(true);
    expect(sourceSuggestDue('monthly', 2, 3)).toBe(false);
    expect(sourceSuggestDue('monthly', 15, 0)).toBe(false);
  });

  it('weekly なら日付に関係なく決められた曜日だけ実行する', () => {
    expect(sourceSuggestDue('weekly', 15, SUGGEST_DOW)).toBe(true);
    expect(sourceSuggestDue('weekly', 1, 1)).toBe(false);
    expect([0,1,2,3,4,5,6].filter(d => sourceSuggestDue('weekly', 10, d))).toEqual([SUGGEST_DOW]);
  });
});
