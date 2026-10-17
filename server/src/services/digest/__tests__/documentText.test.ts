import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { clampDocumentText, decodeTextFile, extractDocxText, MAX_DOCUMENT_TEXT_CHARS } from '../documentText.js';
import { validateAttachments, buildChatUserContent } from '../sourceChat.js';

const DOCX_BASE64 =
  'UEsDBBQAAAAIACOmUV3HHBc8CgAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbLMJqSxILda3AwBQSwMEFAAAAAgAI6ZRXdDzwpFLAQAADQIAABEAAAB3b3JkL2RvY3VtZW50LnhtbIVRu07DMBTd+QrLAxt1YUAoNKkYgJWhfICbmDZSYlu26WN0W9SqCCpAgqEIVtShICY68TFW2vIXOKGACkgsR7r3nnvOuXah2IgjUCNChoy6cD2Xh4BQnwUhrbjwsLS3tgWBVJgGOGKUuLBJJCx6K4W6EzD/OCZUAatApVN3YVUp7iAk/SqJscwxTqidHTERY2VLUUF1JgIumE+ktAZxhDby+U0U45BCz0qWWdDMtHlaiRSU99Y9nw9ujR5Pr5+MvjG6k1zp2cPYtC7no1ejJ0bf22YBpeQURYb8p1Ca05Ec+/YKLogkokagN3vsJMNnByytf3mbds+07yyCVRzzbWDafdOa/MnFZfSxk3RGyUnvvzgBiUqkobzp8MXoM6NPjb7Ibuym7M/pskdIpRJZHxzs7O9mmb97v7Jrm3VgWv2/oqDFY2dmi4/03gFQSwECFAMUAAAACAAjplFdxxwXPAoAAAAIAAAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIACOmUV3Q88KRSwEAAA0CAAARAAAAAAAAAAAAAACAATsAAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAgACAIAAAAC1AQAAAAA=';

describe('Word ファイルから文を取り出す', () => {
  it('段落ごとに改行し、タブと記号を元に戻し、消された文字や埋め込みの命令は含めない', () => {
    const text = extractDocxText(Buffer.from(DOCX_BASE64, 'base64'));
    expect(text).toBe('野菜の新しい品種を調べたい\n範囲: トマト & ナス\t優先\nおわり');
  });

  it('ZIP の形でないデータには null を返す', () => {
    expect(extractDocxText(Buffer.from('これは docx ではない'))).toBeNull();
  });
});

describe('文字ファイルの読み込みと長さの制限', () => {
  it('先頭に付いた BOM を取り除く', () => {
    expect(decodeTextFile(Buffer.from('\uFEFF# タイトル\n中身', 'utf8'))).toBe('# タイトル\n中身');
  });

  it('長すぎる文は上限で切り、切った字数を書き足す', () => {
    const long = 'あ'.repeat(MAX_DOCUMENT_TEXT_CHARS + 5);
    const out = clampDocumentText(long);
    expect(out.startsWith('あ'.repeat(MAX_DOCUMENT_TEXT_CHARS))).toBe(true);
    expect(out).toContain('5 字は省略しました');
  });
});

describe('会話に添付されたファイル', () => {
  it('.md と .docx を受け取り、中の文にして渡す', () => {
    const md = Buffer.from('# メモ\nサンプルの文', 'utf8').toString('base64');
    const result = validateAttachments([
      { kind: 'text', mediaType: '', dataBase64: md, name: 'memo.md' },
      { kind: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dataBase64: DOCX_BASE64, name: 'サンプル.docx' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments.map((a) => [a.kind, a.text])).toEqual([
      ['text', '# メモ\nサンプルの文'],
      ['text', '野菜の新しい品種を調べたい\n範囲: トマト & ナス\t優先\nおわり'],
    ]);
    const blocks = buildChatUserContent('これを見てください', result.attachments, []);
    expect(blocks[0]).toEqual({ type: 'text', text: '添付ファイルの内容（memo.md）:\n# メモ\nサンプルの文' });
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: 'これを見てください' });
  });

  it('開けない Word ファイルと、中身が空白だけのファイルは受け付けない', () => {
    const bad = Buffer.from('not a zip').toString('base64');
    const r1 = validateAttachments([{ kind: 'docx', mediaType: '', dataBase64: bad, name: 'x.docx' }]);
    expect(r1.ok).toBe(false);
    const empty = Buffer.from('   ').toString('base64');
    const r2 = validateAttachments([{ kind: 'text', mediaType: 'text/plain', dataBase64: empty, name: 'x.txt' }]);
    expect(r2.ok).toBe(false);
  });

  it('扱えない形式は、扱える形式を伝えて受け付けない', () => {
    const r = validateAttachments([{ kind: 'text', mediaType: 'application/zip', dataBase64: 'AAAA', name: 'x.zip' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Word（.docx）');
  });
});

describe('展開すると極端に大きくなる ZIP', () => {
  function makeZip(name: string, data: Buffer): Buffer {
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);
    const cdOffset = local.length + nameBuf.length + compressed.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    return Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
  }

  it('展開後の大きさが上限の 20MB を超えるものは読まない', () => {
    const bomb = makeZip('word/document.xml', Buffer.alloc(30 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(extractDocxText(bomb)).toBeNull();
  });

  it('展開後の大きさが小さく書かれていても、展開しながら止める', () => {
    const bomb = makeZip('word/document.xml', Buffer.alloc(30 * 1024 * 1024));
    const cd = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(1024, cd + 24);
    expect(extractDocxText(bomb)).toBeNull();
  });
});

describe('存在しない文字コードの扱い', () => {
  it('Unicode の範囲を超える文字参照はエラーにせず置換文字に変える', () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>A&#x110000;B&#${'9'.repeat(8)};C&#x41;</w:t></w:r></w:p></w:body></w:document>`;
    const data = Buffer.from(xml);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from('word/document.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBuf.length, 12);
    eocd.writeUInt32LE(local.length + nameBuf.length + compressed.length, 16);
    const docx = Buffer.concat([local, nameBuf, compressed, central, nameBuf, eocd]);
    expect(extractDocxText(docx)).toBe('A�B�CA');
  });
});
