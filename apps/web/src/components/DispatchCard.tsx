/**
 * タイムライン上に表示する Dispatch カード（サイクル1.25 要求B: 全面再設計）。
 *
 * 状態 → カード種別の写像は lib/dispatch-status.ts の cardKindFor に集約している
 * （変更禁止）。バッジの色は同ファイルの statusToneOf が返す5トーン（wait/run/ok/ng/unknown）を、
 * 本コンポーネント側で success/warning/danger/neutral の4系統へさらに写像する。
 * cardKindFor は failed/stopped も submitting/planning/approving/building と同じ
 * 'progress' に含めてしまうため、kind だけでスピナーを出すと失敗した Dispatch のスピナーが
 * 回り続ける。そのためスピナーは tone==='run'、danger 帯（statusReason）は tone==='ng' で
 * 出し分ける。
 *
 * 承認・中止系のボタンはすべて、window.confirm ではなく本コンポーネント内 state（confirm）
 * によるインライン確認を1枚挟み、busy 中は disabled にして二重送信を防ぐ
 * （呼び出し元 App.tsx が busy 管理する）。
 */
import { Fragment, useEffect, useState } from 'react';
import type { CoreProjectDto, DispatchDto, DispatchPlanDto } from '../types.js';
import {
  DISPATCH_STATUS_LABELS,
  statusToneOf,
  cardKindFor,
  canCancel,
  doneRowsOf,
  approveNoteOf,
  councilBadgeOf,
} from '../lib/dispatch-status.js';
import type { StatusTone } from '../lib/dispatch-status.js';
import { splitPlanNoise } from '../lib/plan-text.js';
import { Markdown } from './Markdown.js';
import * as api from '../api.js';

interface DispatchCardProps {
  dispatch: DispatchDto;
  projects: CoreProjectDto[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}

type ToneFamily = 'success' | 'warning' | 'danger' | 'neutral';

/** 5トーン → バッジ4系統への写像。run/unknown は neutral にまとめる（run にはスピナーを別途添える）。 */
function toneFamilyOf(tone: StatusTone): ToneFamily {
  switch (tone) {
    case 'ok':
      return 'success';
    case 'wait':
      return 'warning';
    case 'ng':
      return 'danger';
    default:
      return 'neutral';
  }
}

const BADGE_TONE: Record<ToneFamily, string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  neutral: 'border-border bg-muted/10 text-muted',
};

/** ボタン3種のみ使う（primary / secondary / text-danger）。 */
const BTN_PRIMARY =
  'inline-flex items-center justify-center rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_SECONDARY =
  'inline-flex items-center justify-center rounded-sm border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50';
const BTN_TEXT_DANGER =
  'inline-flex items-center justify-center px-1 py-1 text-sm text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-50';

/** projectId を core プロジェクト名に解決する。未解決なら id をそのまま表示する。 */
function resolveProjectName(projectId: string, projects: CoreProjectDto[]): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

/** window.confirm の代替として保持する、実行待ちの確認1件。 */
interface PendingConfirm {
  message: string;
  run: () => Promise<void>;
}

export function DispatchCard({ dispatch, projects, busy, onBusyChange, onChanged, onError, onInfo }: DispatchCardProps) {
  const kind = cardKindFor(dispatch.status);
  const tone = statusToneOf(dispatch.status);
  const family = toneFamilyOf(tone);
  const label = DISPATCH_STATUS_LABELS[dispatch.status] ?? `不明な状態（${dispatch.status}）`;
  const projectName = resolveProjectName(dispatch.projectId, projects);
  const approveNote = approveNoteOf(dispatch);
  const councilBadge = councilBadgeOf(dispatch);

  const [instruction, setInstruction] = useState(dispatch.instruction ?? '');
  const [targetProjectId, setTargetProjectId] = useState(dispatch.projectId);
  const [plan, setPlan] = useState<DispatchPlanDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showNoise, setShowNoise] = useState(false);
  const [approveNoteInput, setApproveNoteInput] = useState('');
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // draft カードは instruction が外から更新されたら編集欄も追随させる。
  useEffect(() => {
    setInstruction(dispatch.instruction ?? '');
  }, [dispatch.instruction]);

  // draft カードは projectId が外から更新されたら選択欄も追随させる。
  useEffect(() => {
    setTargetProjectId(dispatch.projectId);
  }, [dispatch.projectId]);

  // awaiting_approval カードを展開したときに1回だけプランを取得する。
  useEffect(() => {
    if (kind !== 'plan' || !expanded) {
      return;
    }
    let cancelled = false;
    setPlanError(null);
    api
      .getPlan(dispatch.id)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((err) => {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // dispatch.id / expanded が変わるたびに取り直す。kind は dispatch.status から導出されるため依存に含めない。
    // eslint disable 相当のコメント: 依存簡略化の意図的な選択（過剰な再取得を避ける）。
  }, [dispatch.id, expanded]);

  /** 承認・中止系の共通実行部。確認済みの action を busy 化して実行し、再取得する。 */
  async function runAction(action: () => Promise<void>) {
    onBusyChange(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      onBusyChange(false);
    }
  }

  /** window.confirm の代替: インライン確認を1件だけ保持する。 */
  function requestConfirm(message: string, action: () => Promise<void>) {
    if (busy) return;
    setConfirm({ message, run: action });
  }

  function confirmYes() {
    if (!confirm || busy) return;
    const { run } = confirm;
    setConfirm(null);
    void runAction(run);
  }

  function confirmNo() {
    setConfirm(null);
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${BADGE_TONE[family]}`}>
          {label}
        </span>
        {tone === 'run' && (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-accent"
          />
        )}
        {councilBadge && (
          <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted">
            council
          </span>
        )}
        <span className="font-semibold text-text">{projectName}</span>
        {dispatch.tier && <span className="text-xs text-muted">tier: {dispatch.tier}</span>}
        {dispatch.model && <span className="text-xs text-muted">model: {dispatch.model}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">
          {new Date(dispatch.statusChangedAt).toLocaleString('ja-JP')}
        </span>
      </div>

      {dispatch.statusReason && tone === 'ng' && (
        <div className="mt-2 rounded-sm border border-danger/30 bg-danger/10 px-2 py-1.5 text-sm text-danger">
          {dispatch.statusReason}
        </div>
      )}
      {dispatch.statusReason && tone !== 'ng' && (
        <div className="mt-1 text-xs text-muted">{dispatch.statusReason}</div>
      )}
      {approveNote && (
        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">承認メモ: {approveNote}</div>
      )}

      {kind === 'draft' && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 font-mono text-sm text-text focus:border-accent focus:outline-none"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
            rows={10}
          />
          <div className="flex items-center gap-2 text-sm">
            投げ先:
            <select
              className="rounded-sm border border-border bg-bg px-2 py-1 text-sm text-text"
              value={targetProjectId}
              disabled={busy}
              onChange={(e) => setTargetProjectId(e.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                  {!project.online ? '（オフライン）' : ''}
                </option>
              ))}
              {!projects.some((p) => p.id === dispatch.projectId) && (
                <option value={dispatch.projectId}>{projectName}</option>
              )}
            </select>
          </div>
          <div>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || instruction.trim().length === 0}
              onClick={() =>
                requestConfirm('投げ先を承認しますか？（ゲート①）', async () => {
                  const nextProjectId = targetProjectId !== dispatch.projectId ? targetProjectId : undefined;
                  await api.approveTarget(dispatch.id, instruction.trim(), nextProjectId);
                })
              }
            >
              投げ先を承認（ゲート①）
            </button>
          </div>
        </div>
      )}

      {kind === 'plan' && (
        <div className="mt-2 flex flex-col gap-2">
          <div>
            <button type="button" className={BTN_SECONDARY} onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'プランを閉じる' : 'プランを表示'}
            </button>
          </div>
          {expanded && planError && (
            <div className="text-sm text-danger">プラン取得に失敗しました: {planError}</div>
          )}
          {expanded && plan && (
            <div className="flex flex-col gap-2">
              {plan.summary && <Markdown>{plan.summary}</Markdown>}
              {plan.planMarkdown &&
                (() => {
                  const { body, noise } = splitPlanNoise(plan.planMarkdown);
                  return (
                    <>
                      <Markdown>{body}</Markdown>
                      {noise.length > 0 && (
                        <>
                          <div>
                            <button type="button" className={BTN_SECONDARY} onClick={() => setShowNoise((v) => !v)}>
                              {showNoise ? 'ログ行を隠す' : `ログ行を表示 (${noise.length}件)`}
                            </button>
                          </div>
                          {showNoise && (
                            <pre className="whitespace-pre-wrap rounded-sm border border-border bg-bg p-2 text-xs text-muted">
                              {noise.join('\n')}
                            </pre>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}
              {!plan.planMarkdown && (
                <p className="text-sm text-muted">プラン本文はまだありません（status: {plan.status}）。</p>
              )}
            </div>
          )}
          <textarea
            className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
            value={approveNoteInput}
            onChange={(e) => setApproveNoteInput(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="任意: 案B採用など、承認時に agent へ伝える追記"
          />
          <div>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy}
              onClick={() =>
                requestConfirm('プランを承認して実行しますか？（ゲート②）', async () => {
                  const result = await api.approvePlan(dispatch.id, approveNoteInput);
                  onInfo(`承認結果: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
                })
              }
            >
              プランを承認して実行（ゲート②）
            </button>
          </div>
        </div>
      )}

      {kind === 'stale' && (
        <div className="mt-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={busy}
            onClick={() =>
              requestConfirm('プランを再取得しますか？', async () => {
                const result = await api.retryStale(dispatch.id);
                onInfo(`再取得結果: ${result.outcome}`);
              })
            }
          >
            再取得
          </button>
        </div>
      )}

      {kind === 'progress' && tone === 'run' && <div className="mt-2 text-sm text-muted">処理中です…</div>}

      {kind === 'done' && (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          {doneRowsOf(dispatch).map((row) => (
            <Fragment key={row.label}>
              <dt className="font-semibold text-muted">{row.label}</dt>
              <dd className="m-0 break-all">{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {canCancel(dispatch.status) && (
        <div className="mt-2">
          <button
            type="button"
            className={BTN_TEXT_DANGER}
            disabled={busy}
            onClick={() =>
              requestConfirm('この Dispatch を中止しますか？', async () => {
                await api.cancelDispatch(dispatch.id, 'web UI から中止');
              })
            }
          >
            中止
          </button>
        </div>
      )}

      {confirm && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-border bg-bg p-2 text-sm">
          <span className="flex-1">{confirm.message}</span>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={confirmYes}>
            実行
          </button>
          <button type="button" className={BTN_SECONDARY} disabled={busy} onClick={confirmNo}>
            戻す
          </button>
        </div>
      )}
    </div>
  );
}
