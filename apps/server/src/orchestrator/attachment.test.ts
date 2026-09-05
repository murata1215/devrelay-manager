import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TOTAL_TEXT_CHARS,
  decodeAttachmentText,
  detectImageMimeType,
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

/** サイクル1.35: テスト用の画像バイト列（各形式のマジックバイト＋ダミーのペイロード）。 */
function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}
function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}
function gif87aBytes(): Buffer {
  return Buffer.concat([Buffer.from('GIF87a', 'ascii'), Buffer.from([0x01, 0x00, 0x01, 0x00])]);
}
function gif89aBytes(): Buffer {
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x01, 0x00, 0x01, 0x00])]);
}
function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
}
function imageItem(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    filename: 'pasted-image.png',
    mimeType: 'image/png',
    content: pngBytes().toString('base64'),
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

test('194. validateAttachments: 許可外 MIME タイプは mimeNotAllowed で拒否する（サイクル1.35で image/png 等は許可済みになったため application/pdf で検証）', () => {
  const result = validateAttachments([item({ mimeType: 'application/pdf' })]);
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

/* ===== サイクル1.35: 画像添付（フェーズ2） ===== */

test('204. detectImageMimeType: PNG/JPEG/GIF87a/GIF89a/WebP の各シグネチャを正しく判定する', () => {
  assert.equal(detectImageMimeType(pngBytes()), 'image/png');
  assert.equal(detectImageMimeType(jpegBytes()), 'image/jpeg');
  assert.equal(detectImageMimeType(gif87aBytes()), 'image/gif');
  assert.equal(detectImageMimeType(gif89aBytes()), 'image/gif');
  assert.equal(detectImageMimeType(webpBytes()), 'image/webp');
});

test('205. detectImageMimeType: 先頭が一致しないバイト列・短すぎるバッファは null を返す', () => {
  assert.equal(detectImageMimeType(Buffer.from('hello world', 'utf-8')), null);
  assert.equal(detectImageMimeType(Buffer.from([])), null);
  assert.equal(detectImageMimeType(Buffer.from([0x89, 0x50])), null); // PNG シグネチャの途中で切れている
  assert.equal(detectImageMimeType(Buffer.from('RIFFxxxxNOTWEBP', 'ascii')), null); // RIFF だが WEBP ではない
});

test('206. validateAttachments: 画像4形式はいずれも ok:true で kind:"image"・byteSize=実バイト数・content=入力と同一・text=""', () => {
  const cases: Array<[string, AttachmentInput]> = [
    ['png', imageItem({ filename: 'a.png', mimeType: 'image/png', content: pngBytes().toString('base64') })],
    ['jpeg', imageItem({ filename: 'b.jpg', mimeType: 'image/jpeg', content: jpegBytes().toString('base64') })],
    ['gif', imageItem({ filename: 'c.gif', mimeType: 'image/gif', content: gif87aBytes().toString('base64') })],
    ['webp', imageItem({ filename: 'd.webp', mimeType: 'image/webp', content: webpBytes().toString('base64') })],
  ];
  for (const [label, input] of cases) {
    const result = validateAttachments([input]);
    assert.equal(result.ok, true, `${label} は ok:true であるべき`);
    if (result.ok) {
      const d = result.decoded[0];
      assert.equal(d.kind, 'image', `${label}: kind`);
      assert.equal(d.mimeType, input.mimeType, `${label}: mimeType`);
      assert.equal(d.content, input.content, `${label}: content（base64 は再エンコードせずそのまま）`);
      assert.equal(d.text, '', `${label}: 画像の text は常に空文字`);
      assert.equal(d.byteSize, Buffer.from(input.content, 'base64').length, `${label}: byteSize`);
    }
  }
});

test('207. validateAttachments: 拡張子・MIME偽装（宣言 image/png だが実体は JPEG）を mimeMismatch で拒否する', () => {
  const result = validateAttachments([
    imageItem({ filename: 'evil.png', mimeType: 'image/png', content: jpegBytes().toString('base64') }),
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'mimeMismatch');
    assert.match(result.reason, /evil\.png/);
  }
});

test('208. validateAttachments: 画像でも1ファイル上限超過は fileTooLarge、合計上限超過は totalTooLarge で拒否する', () => {
  // 1ファイルが上限を超えるケース: PNG シグネチャ8バイト＋ダミーペイロードで上限超過にする。
  const oversizedPng = Buffer.concat([pngBytes(), Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x00)]);
  const oneTooLarge = validateAttachments([
    imageItem({ mimeType: 'image/png', content: oversizedPng.toString('base64') }),
  ]);
  assert.equal(oneTooLarge.ok, false);
  if (!oneTooLarge.ok) {
    assert.equal(oneTooLarge.code, 'fileTooLarge');
  }

  // 各ファイルは上限以下だが合計で上限を超えるケース。
  const perFile = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 3) + 1;
  assert.ok(perFile <= MAX_ATTACHMENT_BYTES, 'テスト前提: perFile は1ファイル上限以下であること');
  const bigPng = Buffer.concat([pngBytes(), Buffer.alloc(perFile - pngBytes().length, 0x00)]);
  const totalTooLarge = validateAttachments([
    imageItem({ filename: 'a.png', mimeType: 'image/png', content: bigPng.toString('base64') }),
    imageItem({ filename: 'b.png', mimeType: 'image/png', content: bigPng.toString('base64') }),
    imageItem({ filename: 'c.png', mimeType: 'image/png', content: bigPng.toString('base64') }),
  ]);
  assert.equal(totalTooLarge.ok, false);
  if (!totalTooLarge.ok) {
    assert.equal(totalTooLarge.code, 'totalTooLarge');
  }
});

test('209. combinedTextLength: kind:"image" の添付は文字数に数えない（画像のみなら本文長そのもの、text/image混在も画像分を除外）', () => {
  assert.equal(combinedTextLength('本文', [{ text: '', kind: 'image' }]), 2);
  assert.equal(
    combinedTextLength('abc', [
      { text: 'de', kind: 'text' },
      { text: '', kind: 'image' },
      { text: 'fgh', kind: 'text' },
    ]),
    3 + 2 + 3
  );
});

test('210. buildAttachmentContext: 画像の base64 は返り値に一切含まれない', () => {
  const base64 = pngBytes().toString('base64');
  const result = buildAttachmentContext('本文', [
    { filename: 'pasted-image.png', text: '', kind: 'image', mimeType: 'image/png' },
  ]);
  assert.equal(result.includes(base64), false, '画像の base64 が本文へ混入していないこと');
  assert.match(result, /画像添付: 1件/);
  assert.match(result, /pasted-image\.png \[image\/png\]/);
});

test('211. buildAttachmentContext: テキスト＋画像混在時はテキスト部分は従来どおり全文連結、画像はメタ情報1行のみ', () => {
  const result = buildAttachmentContext('本文', [
    { filename: 'note.txt', text: 'テキスト本文', kind: 'text', mimeType: 'text/plain' },
    { filename: 'shot.jpg', text: '', kind: 'image', mimeType: 'image/jpeg' },
  ]);
  assert.match(result, /^本文\n\n--- 添付ファイル: note\.txt ---\nテキスト本文\n\n--- 画像添付: 1件（shot\.jpg \[image\/jpeg\]）---$/);
});

test('212. buildAttachmentContext: 画像0件（全て kind:"text" 明示）なら1.28以降と1バイトも変わらない', () => {
  const result = buildAttachmentContext('本文', [{ filename: 'note.txt', text: '本文の添付', kind: 'text' }]);
  assert.equal(result, '本文\n\n--- 添付ファイル: note.txt ---\n本文の添付');
});

test('213. ALLOWED_IMAGE_MIME_TYPES は4形式（png/jpeg/gif/webp）から成り、ALLOWED_ATTACHMENT_MIME_TYPES に含まれる', () => {
  assert.deepEqual([...ALLOWED_IMAGE_MIME_TYPES].sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
    assert.ok(ALLOWED_ATTACHMENT_MIME_TYPES.includes(mime));
  }
});
