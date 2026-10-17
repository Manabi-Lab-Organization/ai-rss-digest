import { describe, it, expect } from 'vitest';
import { assertPublicUrl, pinnedLookup, readTextLimited, safeFetch } from '../safeFetch.js';

const publicLookup = async () => ['93.184.216.34'];

describe('assertPublicUrl', () => {
  it('外から見える普通の URL は受け付ける', async () => {
    await expect(assertPublicUrl('https://example.com/feed', publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it('http と https 以外の形式は受け付けない', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', publicLookup)).rejects.toThrow(/http/);
    await expect(assertPublicUrl('gopher://x/', publicLookup)).rejects.toThrow(/http/);
  });

  it('内側のネットワーク向けのホスト名は受け付けない', async () => {
    for (const url of [
      'http://localhost/',
      'http://api.internal/',
      'http://metadata.google.internal/',
      'http://printer.local/',
    ]) {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow(/内部ホスト/);
    }
  });

  it('IPv4 の内側向けの番地を直接書いたものは受け付けない', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
      await expect(assertPublicUrl(`http://${ip}/`, publicLookup)).rejects.toThrow(/内部\/予約/);
    }
  });

  it('IPv6 の内側向けの番地を直接書いたものは受け付けない', async () => {
    for (const ip of ['[::1]', '[fc00::1]', '[fd00:ec2::254]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
      await expect(assertPublicUrl(`http://${ip}/`, publicLookup)).rejects.toThrow(/内部\/予約/);
    }
  });

  it('名前を引いた結果に内側の番地が混じっていたら受け付けない', async () => {
    const internalLookup = async () => ['1.2.3.4', '10.1.2.3'];
    await expect(assertPublicUrl('https://evil.example.com/', internalLookup)).rejects.toThrow(/内部\/予約/);
  });

  it('外から見える番地を直接書いたものは受け付ける', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/', publicLookup)).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetch の転送の扱い', () => {
  it('転送先が内側の番地なら、転送のたびに確かめて止める', async () => {
    let hop = 0;
    const fetchFn = (async (url: string) => {
      hop++;
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      }
      return new Response('hidden', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      safeFetch('https://example.com/start', {}, { fetchFn, lookupFn: publicLookup }),
    ).rejects.toThrow(/内部\/予約/);
    expect(hop).toBe(1);
  });

  it('ふつうに 200 が返ればその応答を返す', async () => {
    const fetchFn = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const res = await safeFetch('https://example.com/', {}, { fetchFn, lookupFn: publicLookup });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('IPv4 を中に含む IPv6 や、一斉送信用などの番地は受け付けない', () => {
  const blocked = [
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b:1::a00:1]/',
    'http://[2002:a9fe:a9fe::1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[ff02::1]/',
    'http://[fec0::1]/',
  ];
  for (const url of blocked) {
    it(url, async () => {
      await expect(assertPublicUrl(url)).rejects.toThrow();
    });
  }

  it('IPv4 を中に含む形でも、中の番地が外向きなら受け付ける', async () => {
    await expect(assertPublicUrl('http://[64:ff9b::808:808]/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://[2002:808:808::1]/')).resolves.toBeInstanceOf(URL);
  });
});

describe('使えるポートは 80・443・8080・8443 に限る', () => {
  const publicLookup = async () => ['93.184.216.34'];
  for (const url of ['https://example.com/', 'http://example.com:80/', 'https://example.com:443/', 'http://example.com:8080/feed', 'https://example.com:8443/feed']) {
    it(`受け付ける: ${url}`, async () => {
      await expect(assertPublicUrl(url, publicLookup)).resolves.toBeInstanceOf(URL);
    });
  }
  for (const url of ['http://example.com:22/', 'http://example.com:6379/', 'https://example.com:9200/']) {
    it(`受け付けない: ${url}`, async () => {
      await expect(assertPublicUrl(url, publicLookup)).rejects.toThrow('ポート');
    });
  }
});

describe('readTextLimited', () => {
  it('上限より小さければ最後まで読む', async () => {
    expect(await readTextLimited(new Response('サンプルの文'), 1024)).toBe('サンプルの文');
  });

  it('読んでいる途中で上限を超えたら止めてエラーにする', async () => {
    const big = new Response('a'.repeat(5000));
    await expect(readTextLimited(big, 1000)).rejects.toThrow('大きすぎます');
  });

  it('Content-Length が上限より大きければ、読む前にエラーにする', async () => {
    const res = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(readTextLimited(res, 1000)).rejects.toThrow('大きすぎます');
  });
});

describe('pinnedLookup', () => {
  it('つなぐ直前に名前を引き、内側の番地ならつながない', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      pinnedLookup('localhost', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EBLOCKEDADDR');
  });
});
