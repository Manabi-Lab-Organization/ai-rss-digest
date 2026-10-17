import { describe, it, expect } from 'vitest';
import {
  articleSource, isFeedTier, isOfficialGovernmentHost, normalizeTier, siteHost, tierLabel,
} from '../feedTier.js';

describe('isOfficialGovernmentHost：政府・自治体の公式ドメイン', () => {
  it('go.jp・lg.jp で終わるホストは公式とみなす', () => {
    expect(isOfficialGovernmentHost('www.sample.go.jp')).toBe(true);
    expect(isOfficialGovernmentHost('www.city.sample.lg.jp')).toBe(true);
  });

  it('自治体の地域型のドメインも公式とみなす', () => {
    expect(isOfficialGovernmentHost('www.pref.sample.jp')).toBe(true);
    expect(isOfficialGovernmentHost('www.city.sample.kanto.jp')).toBe(true);
  });

  it('海外の政府のドメインも公式とみなす', () => {
    expect(isOfficialGovernmentHost('agency.sample.gov')).toBe(true);
    expect(isOfficialGovernmentHost('www.sample.gov.zz')).toBe(true);
  });

  it('名前に go や gov を含むだけのホストは公式とみなさない', () => {
    expect(isOfficialGovernmentHost('go.jp.example.com')).toBe(false);
    expect(isOfficialGovernmentHost('government-news.example.com')).toBe(false);
    expect(isOfficialGovernmentHost('sample-gov.example.org')).toBe(false);
    expect(isOfficialGovernmentHost(null)).toBe(false);
  });
});

describe('種別の値', () => {
  it('一次情報だけを残し、それ以外は「分類しない」に読む', () => {
    expect(normalizeTier('primary')).toBe('primary');
    expect(normalizeTier('none')).toBe('none');
    expect(normalizeTier('mass')).toBe('none');
    expect(normalizeTier(undefined)).toBe('none');
  });

  it('設定できる種別かどうかを判定する', () => {
    expect(isFeedTier('primary')).toBe(true);
    expect(isFeedTier('none')).toBe(true);
    expect(isFeedTier('mass')).toBe(false);
  });

  it('表示名を返す', () => {
    expect(tierLabel('primary')).toBe('一次情報');
    expect(tierLabel('unknown')).toBe('分類しない');
  });

  it('siteHost は先頭の www を外したホスト名を返す', () => {
    expect(siteHost('https://www.news.example.com/a')).toBe('news.example.com');
    expect(siteHost('not a url')).toBeNull();
  });
});

describe('articleSource：記事の出典名と種別', () => {
  it('発行元の URL が公式ドメインなら一次情報にする', () => {
    expect(articleSource({
      feedTitle: 'Googleニュース: 新素材', feedTier: 'none',
      sourceName: 'サンプル省', sourceUrl: 'https://www.sample.go.jp', url: 'https://news.google.com/rss/articles/x',
    })).toEqual({ feedTitle: 'サンプル省', feedTier: 'primary', sourceSite: 'sample.go.jp' });
  });

  it('まとめて配信するフィードでは、フィードに付けた種別を記事に当てはめない', () => {
    expect(articleSource({
      feedTitle: 'Googleニュース: 新素材', feedTier: 'primary',
      sourceName: 'サンプル新聞', sourceUrl: 'https://news.example.com', url: 'https://news.google.com/rss/articles/x',
    })).toEqual({ feedTitle: 'サンプル新聞', feedTier: 'none', sourceSite: 'news.example.com' });
  });

  it('発行元が無ければ、フィードの名前と、管理者が付けた種別を使う', () => {
    expect(articleSource({
      feedTitle: '株式会社サンプルのお知らせ', feedTier: 'primary', url: 'https://corp.example.com/news/1',
    })).toEqual({ feedTitle: '株式会社サンプルのお知らせ', feedTier: 'primary', sourceSite: 'corp.example.com' });
  });

  it('種別が付いていないフィードは「分類しない」', () => {
    expect(articleSource({
      feedTitle: 'サンプル技術ニュース', feedTier: 'none', url: 'https://tech.example.org/a',
    })).toEqual({ feedTitle: 'サンプル技術ニュース', feedTier: 'none', sourceSite: 'tech.example.org' });
  });

  it('記事の URL が公式ドメインなら、フィードの種別が無くても一次情報にする', () => {
    expect(articleSource({
      feedTitle: '架空市の新着情報', feedTier: 'none', url: 'https://www.city.sample.lg.jp/news/1',
    }).feedTier).toBe('primary');
  });
});
