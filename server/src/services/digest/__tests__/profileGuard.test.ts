import { describe, it, expect } from 'vitest';
import {
  splitSections, validateProfile, touchedConstitution, constitutionDiff,
  REQUIRED_SECTIONS, CONSTITUTION_SECTIONS, describeProfile,
} from '../profileGuard.js';
import { DEFAULT_EDITORIAL_PROFILE } from '../editorialProfile.js';
import { OTHER_OUTLETS } from '../podcastScript.js';

const base = [
  '本紙の性格:',
  '  - 暮らしと科学を半分ずつ載せる新聞である',
  '関心トピックの重み:',
  '  - トピック: 家庭菜園',
  '    重み: 高',
  '情報源の信頼度ティア（採点時に必ず適用）:',
  '  - 発表した本人の資料を最も重く見る',
  '新規性の要件:',
  '  - 前に出た話の繰り返しは載せない',
  '良い選定の例:',
  '  - 元の資料を確かめた記事',
  '悪い選定の例:',
  '  - うわさだけの記事',
].join('\n');

describe('splitSections', () => {
  it('見出しの行ごとに区切る', () => {
    const s = splitSections(base);
    expect([...s.keys()]).toContain('本紙の性格');
    expect(s.get('本紙の性格')).toContain('半分ずつ載せる新聞');
  });

  it('最初から用意されている方針も、必要な見出しごとに区切れる', () => {
    const s = splitSections(DEFAULT_EDITORIAL_PROFILE);
    for (const required of REQUIRED_SECTIONS) {
      expect([...s.keys()].some((k) => k.startsWith(required))).toBe(true);
    }
  });

  it('同じ文なら何度呼んでも同じ結果になる', () => {
    expect(splitSections(base)).toEqual(splitSections(base));
  });
});

describe('validateProfile', () => {
  it('最初から用意されている方針は問題なしになる', () => {
    expect(validateProfile(DEFAULT_EDITORIAL_PROFILE, DEFAULT_EDITORIAL_PROFILE)).toEqual([]);
  });

  it('なくてはならない見出しが消えていたら問題として返す', () => {
    const broken = base.replace(/情報源の信頼度ティア（採点時に必ず適用）:\n.*\n/, '');
    const problems = validateProfile(broken, base);
    expect(problems.join('\n')).toContain('情報源の信頼度ティア');
    expect(problems.join('\n')).toContain('紙面の質が静かに落ちます');
  });

  it('元よりずっと短くなっていたら問題として返す', () => {
    const summarized = '本紙の性格:\n  - 新聞\n関心トピックの重み:\n  - トピック: 野菜\n'
      + '情報源の信頼度ティア:\n  - 元\n新規性の要件:\n  - 初\n良い選定の例:\n  - 可\n悪い選定の例:\n  - 否';
    const problems = validateProfile(summarized, DEFAULT_EDITORIAL_PROFILE);
    expect(problems.join('\n')).toContain('短くなっています');
  });

  it('媒体の名前が書かれていたら問題として返す', () => {
    const withOutlet = base.replace('発表した本人の資料を最も重く見る', `${OTHER_OUTLETS[0]}を最も重く見る`);
    const problems = validateProfile(withOutlet, base);
    expect(problems.join('\n')).toContain('実在の媒体名');
    expect(problems.join('\n')).toContain('性質で書いて');
  });

  it('ふつうの書き直しなら空の配列を返す', () => {
    const revised = base.replace('うわさだけの記事', 'うわさだけの記事、宣伝の記事');
    expect(validateProfile(revised, base)).toEqual([]);
  });
});

describe('touchedConstitution', () => {
  it('土台となる見出しの中身が変わったら、その見出しの名前を返す', () => {
    const next = base.replace('暮らしと科学を半分ずつ載せる新聞である', '芸能の話を中心に載せる');
    expect(touchedConstitution(next, base)).toEqual(['本紙の性格']);
  });

  it('土台ではない見出しだけが変わったときは空を返す', () => {
    const next = base.replace('うわさだけの記事', 'うわさだけの記事、宣伝の記事');
    expect(touchedConstitution(next, base)).toEqual([]);
  });

  it('話題の重みが変わったら土台が変わったと見なす', () => {
    const next = base.replace('重み: 高', '重み: 低');
    expect(touchedConstitution(next, base)).toContain('関心トピックの重み');
  });

  it('土台として扱う見出しは決まった3つ', () => {
    expect([...CONSTITUTION_SECTIONS]).toEqual(['本紙の性格', '関心トピックの重み', '情報源の信頼度ティア']);
  });
});

describe('constitutionDiff', () => {
  it('変わった土台の見出しについて、前と後の中身を返す', () => {
    const next = base.replace('暮らしと科学を半分ずつ載せる新聞である', '芸能の話を中心に載せる');
    const diff = constitutionDiff(next, base);
    expect(diff).toHaveLength(1);
    expect(diff[0].section).toBe('本紙の性格');
    expect(diff[0].before).toContain('半分ずつ載せる新聞');
    expect(diff[0].after).toContain('芸能');
  });

  it('何も変わっていなければ空を返す', () => {
    expect(constitutionDiff(base, base)).toEqual([]);
  });
});

describe('describeProfile', () => {
  it('見出しごとに分け、土台の見出しには印を付ける', () => {
    const { chars, sections } = describeProfile(base);
    expect(chars).toBe(base.length);
    const byName = new Map(sections.map((s) => [s.name, s.isConstitution]));
    expect(byName.get('本紙の性格')).toBe(true);
    expect(byName.get('関心トピックの重み')).toBe(true);
    expect(byName.get('情報源の信頼度ティア（採点時に必ず適用）')).toBe(true);
    expect(byName.get('新規性の要件')).toBe(false);
    expect(byName.get('良い選定の例')).toBe(false);
    expect(byName.get('悪い選定の例')).toBe(false);
  });

  it('最初から用意されている方針でも、土台の見出しが3つ見つかる', () => {
    const { sections } = describeProfile(DEFAULT_EDITORIAL_PROFILE);
    expect(sections.filter((s) => s.isConstitution)).toHaveLength(3);
    expect(sections.length).toBeGreaterThanOrEqual(6);
  });

  it('見出しごとに分けても中身の文が欠けない', () => {
    const { sections } = describeProfile(base);
    expect(sections.find((s) => s.name === '本紙の性格')?.body).toContain('半分ずつ載せる新聞');
  });
});
