import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASTE_ATTACH_THRESHOLD,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  shouldAttachPaste,
  uniqueFilename,
  mimeTypeForFilename,
  validateFilename,
  validateAttachments,
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
    text,
    byteSize: new TextEncoder().encode(text).length,
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
