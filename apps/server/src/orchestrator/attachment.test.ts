import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TOTAL_TEXT_CHARS,
  decodeAttachmentText,
  validateAttachments,
  combinedTextLength,
  buildAttachmentContext,
  type AttachmentInput,
} from './attachment.js';

/** テスト用: 文字列 → 添付 content と同じ形（base64）へ変換する。 */
function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

function item(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    filename: 'note.txt',
    mimeType: 'text/plain',
    content: toBase64('hello'),
    ...overrides,
  };
}

test('189. decodeAttachmentText: 日本語を含む正しい base64 は往復デコードで元の文字列に一致する', () => {
  const original = '日本語のテキストです。改行\nも含む。';
  const decoded = decodeAttachmentText(toBase64(original));
  assert.equal(decoded, original);
});

test('190. decodeAttachmentText: base64 として不正、または UTF-8 として不正なバイト列は null を返す', () => {
  assert.equal(decodeAttachmentText('これはbase64ではない'), null);
  assert.equal(decodeAttachmentText('!!!not-base64!!!'), null);
  // 0xFF 単体は有効な UTF-8 バイト列ではない。
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
  assert.equal(decodeAttachmentText(invalidUtf8), null);
});

test('191. validateAttachments: 11件（上限10件超過）は tooMany で拒否する', () => {
  const items = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => item({ filename: `f${i}.txt` }));
  const result = validateAttachments(items);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'tooMany');
    assert.match(result.reason, /10/);
  }
});

test('192. validateAttachments: 空文字・"."・".."・区切り文字混入・255バイト超のファイル名は itemInvalid で拒否する', () => {
  for (const filename of ['', '   ', '.', '..', 'a/b.txt', 'a\\b.txt', 'あ'.repeat(90)]) {
    const result = validateAttachments([item({ filename })]);
    assert.equal(result.ok, false, `filename="${filename}" は拒否されるべき`);
    if (!result.ok) {
      assert.equal(result.code, 'itemInvalid');
    }
  }
});

test('193. validateAttachments: content が空文字のアイテムは itemInvalid で拒否する', () => {
  const result = validateAttachments([item({ content: '' })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'itemInvalid');
  }
});

test('194. validateAttachments: 許可外 MIME タイプは mimeNotAllowed で拒否する', () => {
  const result = validateAttachments([item({ mimeType: 'image/png' })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'mimeNotAllowed');
    for (const allowed of ALLOWED_ATTACHMENT_MIME_TYPES) {
      assert.match(result.reason, new RegExp(allowed.replace('/', '\\/')));
    }
  }
});

test('195. validateAttachments: 不正な base64 は base64Invalid で拒否する', () => {
  const result = validateAttachments([item({ content: '!!!invalid-base64!!!' })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'base64Invalid');
  }
});

test('196. validateAttachments: 有効な base64 だが UTF-8 として不正なバイト列は notUtf8 で拒否する', () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
  const result = validateAttachments([item({ content: invalidUtf8 })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'notUtf8');
  }
});

test('197. validateAttachments: 1ファイルが上限バイト数を超えると fileTooLarge で拒否する', () => {
  const oversized = 'a'.repeat(MAX_ATTACHMENT_BYTES + 1);
  const result = validateAttachments([item({ content: toBase64(oversized) })]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'fileTooLarge');
  }
});

test('198. validateAttachments: 各ファイルは上限以下でも合計が上限を超えると totalTooLarge で拒否する', () => {
  // 1ファイルあたり MAX_ATTACHMENT_BYTES 未満に収めつつ、3ファイルの合計で MAX_TOTAL_ATTACHMENT_BYTES を超えさせる。
  const perFile = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 3) + 1;
  assert.ok(perFile <= MAX_ATTACHMENT_BYTES, 'テスト前提: perFile は1ファイル上限以下であること');
  const items = [
    item({ filename: 'a.txt', content: toBase64('a'.repeat(perFile)) }),
    item({ filename: 'b.txt', content: toBase64('a'.repeat(perFile)) }),
    item({ filename: 'c.txt', content: toBase64('a'.repeat(perFile)) }),
  ];
  const result = validateAttachments(items);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'totalTooLarge');
  }
});

test('199. validateAttachments: 正常系は ok:true で filename が trim され、text/byteSize/content が復元される', () => {
  const result = validateAttachments([
    item({ filename: '  note.md  ', mimeType: 'text/markdown', content: toBase64('本文です') }),
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.decoded.length, 1);
    const d = result.decoded[0];
    assert.equal(d.filename, 'note.md');
    assert.equal(d.mimeType, 'text/markdown');
    assert.equal(d.text, '本文です');
    assert.equal(d.byteSize, Buffer.byteLength('本文です', 'utf-8'));
    assert.equal(d.content, toBase64('本文です'));
  }
});

test('200. combinedTextLength: 本文の文字数と添付全文の文字数の合計を返す（本文単独・添付複数の両方）', () => {
  assert.equal(combinedTextLength('abc', []), 3);
  assert.equal(combinedTextLength('abc', [{ text: 'de' }, { text: 'fgh' }]), 3 + 2 + 3);
});

test('201. buildAttachmentContext: 添付が空なら content を1バイトも変えずにそのまま返す（後方互換）', () => {
  const content = 'これは本文です。改行\nも含む。';
  assert.equal(buildAttachmentContext(content, []), content);
});

test('202. buildAttachmentContext: 添付が非空なら見出し付きで全文をそのまま連結する（要約・切り詰めなし）', () => {
  const longText = 'x'.repeat(5000);
  const result = buildAttachmentContext('本文', [
    { filename: 'pasted-text.txt', text: longText },
    { filename: 'note.md', text: '第二の添付' },
  ]);
  assert.match(result, /^本文\n\n--- 添付ファイル: pasted-text\.txt ---\n/);
  assert.ok(result.includes(longText), '添付本文が切り詰められずに全文含まれること');
  assert.match(result, /--- 添付ファイル: note\.md ---\n第二の添付$/);
});

test('203. MAX_TOTAL_TEXT_CHARS は 140,000（light tier の200,000トークン窓から出力・system prompt分を引いて安全マージンを掛けた値）', () => {
  assert.equal(MAX_TOTAL_TEXT_CHARS, 140_000);
});
