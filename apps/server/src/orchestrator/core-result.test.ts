import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlanResult, classifyBuildResult } from './core-result.js';

test('34. classifyPlanResult: not_found を検出する（staleCheck の根拠）', () => {
  const result = classifyPlanResult({ status: 'not_found', error: 'Submission not found' });
  assert.equal(result.kind, 'not_found');
});

test('35. classifyPlanResult: pending 系ステータスは pending', () => {
  assert.equal(classifyPlanResult({ status: 'planning' }).kind, 'pending');
  assert.equal(classifyPlanResult({ status: 'pending' }).kind, 'pending');
});

test('36. classifyPlanResult: ready は planMarkdown を保持する', () => {
  const result = classifyPlanResult({ status: 'ready', planMarkdown: '# plan' });
  assert.equal(result.kind, 'ready');
  assert.equal(result.planMarkdown, '# plan');
});

test('37. classifyPlanResult: error ステータスは error', () => {
  assert.equal(classifyPlanResult({ status: 'error' }).kind, 'error');
});

test('38. classifyPlanResult: 未知の status / status 欠落は unknown', () => {
  assert.equal(classifyPlanResult({ status: 'something_new' }).kind, 'unknown');
  assert.equal(classifyPlanResult({}).kind, 'unknown');
  assert.equal(classifyPlanResult(null).kind, 'unknown');
  assert.equal(classifyPlanResult('not an object').kind, 'unknown');
});

test('39. classifyBuildResult: done:false は running（実測応答の回帰テスト）', () => {
  // 実測: getBuildStatus(存在しないsubmissionId) -> {"phase":"queued","message":"...","done":false}
  const result = classifyBuildResult({
    phase: 'queued',
    message: 'Build is queued or in progress. Please wait and try again.',
    done: false,
  });
  assert.equal(result.kind, 'running');
});

test('40. classifyBuildResult: done:true かつ成功系フィールドで succeeded / failed を判定', () => {
  assert.equal(classifyBuildResult({ done: true, phase: 'succeeded' }).kind, 'succeeded');
  assert.equal(classifyBuildResult({ done: true, success: true }).kind, 'succeeded');
  assert.equal(classifyBuildResult({ done: true, phase: 'failed' }).kind, 'failed');
  assert.equal(classifyBuildResult({ done: true, success: false }).kind, 'failed');
});

test('41. classifyBuildResult: done:true だが成否不明の語彙・done欠落/型不正は unknown', () => {
  assert.equal(classifyBuildResult({ done: true, phase: 'mystery' }).kind, 'unknown');
  assert.equal(classifyBuildResult({}).kind, 'unknown'); // done フィールド欠落
  assert.equal(classifyBuildResult({ done: 'nope' }).kind, 'unknown'); // done が真偽値でない
  assert.equal(classifyBuildResult(null).kind, 'unknown');
});

// ── サイクル1.19 S4/S5: devlogPath の取りこぼし修正 ─────────────────────────

test('157. classifyBuildResult: devlogPath / devlog_path / devlog の順で最初に見つかった string を拾う', () => {
  assert.equal(
    classifyBuildResult({ done: true, phase: 'succeeded', devlogPath: 'doc/devlog/a.md' }).devlogPath,
    'doc/devlog/a.md'
  );
  assert.equal(
    classifyBuildResult({ done: true, phase: 'succeeded', devlog_path: 'doc/devlog/b.md' }).devlogPath,
    'doc/devlog/b.md'
  );
  assert.equal(
    classifyBuildResult({ done: true, phase: 'succeeded', devlog: 'doc/devlog/c.md' }).devlogPath,
    'doc/devlog/c.md'
  );
  // 複数存在する場合は devlogPath が最優先
  assert.equal(
    classifyBuildResult({
      done: true,
      phase: 'succeeded',
      devlogPath: 'doc/devlog/a.md',
      devlog_path: 'doc/devlog/b.md',
    }).devlogPath,
    'doc/devlog/a.md'
  );
});

test('158. classifyBuildResult: devlog 系フィールドが無ければ devlogPath は undefined', () => {
  assert.equal(classifyBuildResult({ done: true, phase: 'succeeded' }).devlogPath, undefined);
  assert.equal(classifyBuildResult({ done: false, phase: 'queued' }).devlogPath, undefined);
});
