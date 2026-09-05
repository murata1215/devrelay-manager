import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PASTE_ATTACH_THRESHOLD,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_TOTAL_TEXT_CHARS,
  ALLOWED_IMAGE_MIME_TYPES,
  shouldAttachPaste,
  uniqueFilename,
  mimeTypeForFilename,
  imageExtensionForMimeType,
  detectImageMimeType,
  bytesToBase64,
  validateFilename,
  validateAttachments,
  combinedTextLength,
  formatBytes,
  toWireAttachments,
  type Attachment,
} from './attachment.js';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  const text = overrides.text ?? 'hello';
  return {
    id: 'a1',
    filename: 'note.txt',
    mimeType: 'text/plain',
    kind: 'text',
    text,
    base64: '',
    byteSize: new TextEncoder().encode(text).length,
    ...overrides,
  };
}

/** サイクル1.35: テスト用の画像バイト列（server 側 attachment.test.ts と同じフィクスチャ）。 */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}
function gif87aBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00]);
}
function gif89aBytes(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
}
function webpBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
}

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  const bytes = pngBytes();
  return {
    id: 'img1',
    filename: 'pasted-image.png',
    mimeType: 'image/png',
    kind: 'image',
    text: '',
    base64: bytesToBase64(bytes),
    byteSize: bytes.length,
    ...overrides,
  };
}

test('34. shouldAttachPaste: 閾値ちょうど(2000)は false、1文字超過(2001)は true', () => {
  assert.equal(shouldAttachPaste('a'.repeat(PASTE_ATTACH_THRESHOLD)), false);
  assert.equal(shouldAttachPaste('a'.repeat(PASTE_ATTACH_THRESHOLD + 1)), true);
});

test('35. uniqueFilename: 未使用ならそのまま返す', () => {
  assert.equal(uniqueFilename('pasted-text.txt', []), 'pasted-text.txt');
  assert.equal(uniqueFilename('pasted-text.txt', ['other.txt']), 'pasted-text.txt');
});

test('36. uniqueFilename: 使用済みなら最小の未使用番号を -2, -3, … と付ける（拡張子保持）', () => {
  assert.equal(uniqueFilename('pasted-text.txt', ['pasted-text.txt']), 'pasted-text-2.txt');
  assert.equal(
    uniqueFilename('pasted-text.txt', ['pasted-text.txt', 'pasted-text-2.txt']),
    'pasted-text-3.txt'
  );
});

test('37. uniqueFilename: 中抜き削除後は空いた番号を再利用する（隠しカウンタを持たない）', () => {
  // pasted-text-2.txt が削除され、pasted-text.txt と pasted-text-3.txt だけが残っている状況。
  const existing = ['pasted-text.txt', 'pasted-text-3.txt'];
  assert.equal(uniqueFilename('pasted-text.txt', existing), 'pasted-text-2.txt');
  // 全件を列挙してユニークであることを機械確認する。
  const names = new Set<string>();
  let current = ['pasted-text.txt'];
  for (let i = 0; i < 5; i += 1) {
    const next = uniqueFilename('pasted-text.txt', current);
    assert.equal(names.has(next), false);
    names.add(next);
    current = [...current, next];
  }
});

test('38. uniqueFilename: ファイル添付の重複名にも使える（拡張子が .md でも同様に動く）', () => {
  assert.equal(uniqueFilename('notes.md', ['notes.md']), 'notes-2.md');
});

test('39. mimeTypeForFilename: .txt/.log は text/plain、.md/.markdown は text/markdown（大文字可）', () => {
  assert.equal(mimeTypeForFilename('a.txt'), 'text/plain');
  assert.equal(mimeTypeForFilename('a.LOG'), 'text/plain');
  assert.equal(mimeTypeForFilename('a.md'), 'text/markdown');
  assert.equal(mimeTypeForFilename('a.MARKDOWN'), 'text/markdown');
});

test('40. mimeTypeForFilename: 未許可拡張子・拡張子無しは null', () => {
  assert.equal(mimeTypeForFilename('a.png'), null);
  assert.equal(mimeTypeForFilename('noext'), null);
});

test('41. validateFilename: 空・空白のみ・"."・".."・区切り文字・255バイト超を拒否する', () => {
  assert.notEqual(validateFilename(''), null);
  assert.notEqual(validateFilename('   '), null);
  assert.notEqual(validateFilename('.'), null);
  assert.notEqual(validateFilename('..'), null);
  assert.notEqual(validateFilename('a/b.txt'), null);
  assert.notEqual(validateFilename('a\\b.txt'), null);
  assert.notEqual(validateFilename(`${'a'.repeat(256)}.txt`), null);
  assert.equal(validateFilename('ok.txt'), null);
});

test('42. validateAttachments: 11件目を拒否する（上限10件）', () => {
  const items = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) =>
    attachment({ id: `a${i}`, filename: `f${i}.txt` })
  );
  const reason = validateAttachments(items);
  assert.notEqual(reason, null);
  assert.match(reason ?? '', /10/);
});

test('43. validateAttachments: 1ファイルが上限バイト数を超えたら拒否する', () => {
  const items = [attachment({ byteSize: MAX_ATTACHMENT_BYTES + 1 })];
  const reason = validateAttachments(items);
  assert.notEqual(reason, null);
});

test('44. validateAttachments: 合計が上限バイト数を超えたら拒否する', () => {
  const perFile = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 3) + 1;
  assert.ok(perFile <= MAX_ATTACHMENT_BYTES, 'テスト前提: perFile は1ファイル上限以下であること');
  const items = [
    attachment({ id: 'a1', filename: 'f1.txt', byteSize: perFile }),
    attachment({ id: 'a2', filename: 'f2.txt', byteSize: perFile }),
    attachment({ id: 'a3', filename: 'f3.txt', byteSize: perFile }),
  ];
  const reason = validateAttachments(items);
  assert.notEqual(reason, null);
});

test('45. validateAttachments: \\uFFFD混入（不正UTF-8由来）を拒否する', () => {
  const items = [attachment({ text: 'broken\uFFFDtext' })];
  const reason = validateAttachments(items);
  assert.notEqual(reason, null);
});

test('46. validateAttachments: すべて妥当なら null', () => {
  const items = [attachment()];
  assert.equal(validateAttachments(items), null);
});

test('47. formatBytes: B/KB/MB の境界', () => {
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1000), '1.0 KB');
  assert.equal(formatBytes(999_999), '1000.0 KB');
  assert.equal(formatBytes(1_000_000), '1.0 MB');
});

test('48. toWireAttachments: base64 往復でテキストが一致し、filename/mimeType が保持される（順序も保持）', () => {
  const items = [
    attachment({ id: 'a1', filename: 'first.txt', text: 'hello world' }),
    attachment({ id: 'a2', filename: 'second.md', mimeType: 'text/markdown', text: '日本語のテキスト' }),
  ];
  const wire = toWireAttachments(items);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].filename, 'first.txt');
  assert.equal(wire[0].mimeType, 'text/plain');
  assert.equal(Buffer.from(wire[0].content, 'base64').toString('utf-8'), 'hello world');
  assert.equal(wire[1].filename, 'second.md');
  assert.equal(wire[1].mimeType, 'text/markdown');
  assert.equal(Buffer.from(wire[1].content, 'base64').toString('utf-8'), '日本語のテキスト');
});

test('58. combinedTextLength: 本文＋添付全文の合計文字数（添付ゼロなら本文長そのもの）', () => {
  assert.equal(combinedTextLength('hello', []), 5);
  const items = [attachment({ text: 'ab' }), attachment({ id: 'a2', filename: 'f2.txt', text: 'cde' })];
  assert.equal(combinedTextLength('hello', items), 5 + 2 + 3);
});

test('59. validateAttachments: 合計文字数がちょうど上限なら null、1文字超で拒否する（サイクル1.29）', () => {
  // 添付側でちょうど上限に達するケース。
  const exact = [attachment({ text: 'a'.repeat(MAX_TOTAL_TEXT_CHARS) })];
  assert.equal(validateAttachments(exact, ''), null);
  const overByAttachment = [attachment({ text: 'a'.repeat(MAX_TOTAL_TEXT_CHARS + 1) })];
  const reason1 = validateAttachments(overByAttachment, '');
  assert.notEqual(reason1, null);
  assert.match(reason1 ?? '', new RegExp(String(MAX_TOTAL_TEXT_CHARS)));
  assert.match(reason1 ?? '', /要約・切り詰めは行いません/);

  // 本文側を足したことで超えるケース（添付は上限未満）。
  const smallAttachment = [attachment({ text: 'a'.repeat(100) })];
  assert.equal(validateAttachments(smallAttachment, 'b'.repeat(MAX_TOTAL_TEXT_CHARS - 100)), null);
  const reason2 = validateAttachments(smallAttachment, 'b'.repeat(MAX_TOTAL_TEXT_CHARS - 100 + 1));
  assert.notEqual(reason2, null);

  // content 省略時（既定 ''）は 1.28 以前と同じ挙動（添付単体のみで判定）。
  assert.equal(validateAttachments([attachment({ text: 'short' })]), null);
});

test('60. [ドリフト検出] web と server の添付上限4定数が一致する（server/src/orchestrator/attachment.ts をテキスト照合）', () => {
  const serverPath = fileURLToPath(new URL('../../../server/src/orchestrator/attachment.ts', import.meta.url));
  const serverSource = readFileSync(serverPath, 'utf-8');

  function extractConst(name: string): number {
    const re = new RegExp(`export const ${name} = ([\\d_]+);`);
    const match = serverSource.match(re);
    assert.ok(match, `server 側に export const ${name} = <数値>; が見つかりません（パス: ${serverPath}）`);
    return Number(match![1].replace(/_/g, ''));
  }

  assert.equal(MAX_ATTACHMENT_COUNT, extractConst('MAX_ATTACHMENT_COUNT'));
  assert.equal(MAX_ATTACHMENT_BYTES, extractConst('MAX_ATTACHMENT_BYTES'));
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, extractConst('MAX_TOTAL_ATTACHMENT_BYTES'));
  assert.equal(MAX_TOTAL_TEXT_CHARS, extractConst('MAX_TOTAL_TEXT_CHARS'));
});

test('214. [ドリフト検出] ALLOWED_IMAGE_MIME_TYPES が web と server で一致する（サイクル1.35、#60と同じテキスト照合方式）', () => {
  const serverPath = fileURLToPath(new URL('../../../server/src/orchestrator/attachment.ts', import.meta.url));
  const serverSource = readFileSync(serverPath, 'utf-8');
  const match = serverSource.match(/export const ALLOWED_IMAGE_MIME_TYPES = \[([^\]]*)\] as const;/);
  assert.ok(match, `server 側に export const ALLOWED_IMAGE_MIME_TYPES = [...] as const; が見つかりません（パス: ${serverPath}）`);
  const serverValues = match![1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
  assert.deepEqual([...ALLOWED_IMAGE_MIME_TYPES].sort(), serverValues.sort());
});

/* ===== サイクル1.35: 画像添付（フェーズ2） ===== */

test('215. detectImageMimeType（web版）: PNG/JPEG/GIF87a/GIF89a/WebP の各シグネチャを正しく判定する', () => {
  assert.equal(detectImageMimeType(pngBytes()), 'image/png');
  assert.equal(detectImageMimeType(jpegBytes()), 'image/jpeg');
  assert.equal(detectImageMimeType(gif87aBytes()), 'image/gif');
  assert.equal(detectImageMimeType(gif89aBytes()), 'image/gif');
  assert.equal(detectImageMimeType(webpBytes()), 'image/webp');
});

test('216. detectImageMimeType（web版）: 先頭が一致しないバイト列・短すぎるバッファは null を返す', () => {
  assert.equal(detectImageMimeType(new TextEncoder().encode('hello world')), null);
  assert.equal(detectImageMimeType(new Uint8Array([])), null);
  assert.equal(detectImageMimeType(new Uint8Array([0x89, 0x50])), null);
});

test('217. imageExtensionForMimeType: 4形式のマッピング', () => {
  assert.equal(imageExtensionForMimeType('image/png'), '.png');
  assert.equal(imageExtensionForMimeType('image/jpeg'), '.jpg');
  assert.equal(imageExtensionForMimeType('image/gif'), '.gif');
  assert.equal(imageExtensionForMimeType('image/webp'), '.webp');
});

test('218. toWireAttachments: kind:"image" は base64 フィールドをそのまま使い（再エンコードしない）、テキストは従来どおり。順序も保持する', () => {
  const items = [
    attachment({ id: 'a1', filename: 'first.txt', text: 'hello world' }),
    imageAttachment({ id: 'a2', filename: 'pasted-image.png' }),
  ];
  const wire = toWireAttachments(items);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].filename, 'first.txt');
  assert.equal(Buffer.from(wire[0].content, 'base64').toString('utf-8'), 'hello world');
  assert.equal(wire[1].filename, 'pasted-image.png');
  assert.equal(wire[1].mimeType, 'image/png');
  assert.equal(wire[1].content, items[1].base64, '画像は item.base64 をそのまま使う（再エンコードしない）');
});

test('219. combinedTextLength: kind:"image" の添付は文字数に数えない（テキスト＋画像混在でも画像分は0扱い）', () => {
  assert.equal(combinedTextLength('本文', [imageAttachment()]), 2);
  const items = [attachment({ text: 'ab' }), imageAttachment(), attachment({ id: 'a3', filename: 'f2.txt', text: 'cde' })];
  assert.equal(combinedTextLength('hello', items), 5 + 2 + 3);
});

test('220. validateAttachments: kind:"image" は \\uFFFD 検査の対象外（画像は text が空文字のため通常は問題ないが、対象外であることを機械確認する）だがサイズ判定の対象内', () => {
  // 画像は \uFFFD 混入検査の対象外（server 側と同じ「画像は UTF-8 検査を経由しない」という設計を反映）。
  assert.equal(validateAttachments([imageAttachment({ text: 'broken\uFFFDtext' })]), null);
  // サイズ判定は画像も対象内。
  const oversized = imageAttachment({ byteSize: MAX_ATTACHMENT_BYTES + 1 });
  assert.notEqual(validateAttachments([oversized]), null);
});

test('221. uniqueFilename: pasted-image.png の採番も pasted-text.txt と同じ規則（-2, -3, …）に従う', () => {
  assert.equal(uniqueFilename('pasted-image.png', ['pasted-image.png']), 'pasted-image-2.png');
  assert.equal(
    uniqueFilename('pasted-image.png', ['pasted-image.png', 'pasted-image-2.png']),
    'pasted-image-3.png'
  );
});

test('222. ALLOWED_IMAGE_MIME_TYPES は4形式（png/jpeg/gif/webp）から成る', () => {
  assert.deepEqual([...ALLOWED_IMAGE_MIME_TYPES].sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
});
