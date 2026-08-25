import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSelfLoop, annotateCandidates } from './project-proposal.js';
import type { ProjectCandidate } from './project-proposal.js';

test('96. detectSelfLoop: 完全一致・末尾スラッシュ差・サブパスを自己ループとして検出する', () => {
  const manager = '/home/keisuke/devrelay-manager';
  assert.equal(detectSelfLoop('/home/keisuke/devrelay-manager', manager), true);
  assert.equal(detectSelfLoop('/home/keisuke/devrelay-manager/', manager), true);
  assert.equal(detectSelfLoop('/home/keisuke/devrelay-manager/apps/server', manager), true);
});

test('97. detectSelfLoop: 無関係なパスや紛らわしい接頭辞違いは自己ループと判定しない', () => {
  const manager = '/home/keisuke/devrelay-manager';
  assert.equal(detectSelfLoop('/home/keisuke/other-repo', manager), false);
  // 接頭辞は一致するが別ディレクトリ（devrelay-manager-clone）はサブパスではない
  assert.equal(detectSelfLoop('/home/keisuke/devrelay-manager-clone', manager), false);
});

test('98. annotateCandidates: 自己ループ候補にのみ警告を付け、候補からは除外しない', () => {
  const manager = '/home/keisuke/devrelay-manager';
  const candidates: ProjectCandidate[] = [
    { projectId: 'self', name: 'devrelay-manager', path: manager, machine: 'm1', online: true },
    { projectId: 'other', name: 'pixblog', path: '/srv/pixblog', machine: 'm1', online: true },
  ];
  const annotated = annotateCandidates(candidates, manager);
  assert.equal(annotated.length, 2);
  const self = annotated.find((c) => c.projectId === 'self');
  const other = annotated.find((c) => c.projectId === 'other');
  assert.equal(self?.selfLoopWarning, true);
  assert.ok(self?.warningText && self.warningText.length > 0);
  assert.equal(other?.selfLoopWarning, false);
  assert.equal(other?.warningText, undefined);
});
