/**
 * タイムライン上に表示する Dispatch カード。
 *
 * 状態 → カード種別の写像は lib/dispatch-status.ts の cardKindFor に集約している。
 * 承認・中止系のボタンはすべて window.confirm を1枚挟み、busy 中は disabled にして
 * 二重送信を防ぐ（呼び出し元 App.tsx が busy 管理する）。
 */
import { Fragment, useEffect, useState } from 'react';
import type { CoreProjectDto, DispatchDto, DispatchPlanDto } from '../types.js';
import {
  DISPATCH_STATUS_LABELS,
  statusToneOf,
  cardKindFor,
  canCancel,
  doneRowsOf,
} from '../lib/dispatch-status.js';
import { splitPlanNoise } from '../lib/plan-text.js';
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

/** projectId を core プロジェクト名に解決する。未解決なら id をそのまま表示する。 */
function resolveProjectName(projectId: string, projects: CoreProjectDto[]): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

export function DispatchCard({ dispatch, projects, busy, onBusyChange, onChanged, onError, onInfo }: DispatchCardProps) {
  const kind = cardKindFor(dispatch.status);
  const tone = statusToneOf(dispatch.status);
  const label = DISPATCH_STATUS_LABELS[dispatch.status] ?? `不明な状態（${dispatch.status}）`;
  const projectName = resolveProjectName(dispatch.projectId, projects);

  const [instruction, setInstruction] = useState(dispatch.instruction ?? '');
  const [targetProjectId, setTargetProjectId] = useState(dispatch.projectId);
  const [plan, setPlan] = useState<DispatchPlanDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showNoise, setShowNoise] = useState(false);

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

  /** 承認・中止系の共通実行ラッパ。confirm → busy 化 → 実行 → 再取得を1箇所にまとめる。 */
  async function runGate(confirmMessage: string, action: () => Promise<void>) {
    if (busy) return;
    if (!window.confirm(confirmMessage)) return;
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

  return (
    <div className="dispatch-card">
      <div className="dispatch-card__header">
        <span className={`badge badge--${tone}`}>{label}</span>
        <span className="dispatch-card__project">{projectName}</span>
        {dispatch.tier && <span className="dispatch-card__meta">tier: {dispatch.tier}</span>}
        {dispatch.model && <span className="dispatch-card__meta">model: {dispatch.model}</span>}
        <span className="dispatch-card__meta">{new Date(dispatch.statusChangedAt).toLocaleString('ja-JP')}</span>
      </div>
      {dispatch.statusReason && <div className="dispatch-card__reason">{dispatch.statusReason}</div>}

      {kind === 'draft' && (
        <div className="dispatch-card__body">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
            rows={4}
          />
          <div className="dispatch-card__target">
            投げ先:
            <select
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
          <button
            type="button"
            disabled={busy || instruction.trim().length === 0}
            onClick={() =>
              void runGate('投げ先を承認します（ゲート①）。よろしいですか？', async () => {
                const nextProjectId = targetProjectId !== dispatch.projectId ? targetProjectId : undefined;
                await api.approveTarget(dispatch.id, instruction.trim(), nextProjectId);
              })
            }
          >
            投げ先を承認（ゲート①）
          </button>
        </div>
      )}

      {kind === 'plan' && (
        <div className="dispatch-card__body">
          <button type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'プランを閉じる' : 'プランを表示'}
          </button>
          {expanded && planError && <div className="dispatch-card__error">プラン取得に失敗しました: {planError}</div>}
          {expanded && plan && (
            <div className="dispatch-card__plan">
              {plan.summary && <p className="dispatch-card__summary">{plan.summary}</p>}
              {plan.planMarkdown &&
                (() => {
                  const { body, noise } = splitPlanNoise(plan.planMarkdown);
                  return (
                    <>
                      <pre>{body}</pre>
                      {noise.length > 0 && (
                        <>
                          <button type="button" onClick={() => setShowNoise((v) => !v)}>
                            {showNoise ? 'ログ行を隠す' : `ログ行を表示 (${noise.length}件)`}
                          </button>
                          {showNoise && <pre className="dispatch-card__plan-noise">{noise.join('\n')}</pre>}
                        </>
                      )}
                    </>
                  );
                })()}
              {!plan.planMarkdown && <p>プラン本文はまだありません（status: {plan.status}）。</p>}
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void runGate('プランを承認して実行します（ゲート②）。よろしいですか？', async () => {
                const result = await api.approvePlan(dispatch.id);
                onInfo(`承認結果: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
              })
            }
          >
            プランを承認して実行（ゲート②）
          </button>
        </div>
      )}

      {kind === 'stale' && (
        <div className="dispatch-card__body">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void runGate('プランを再取得します。よろしいですか？', async () => {
                const result = await api.retryStale(dispatch.id);
                onInfo(`再取得結果: ${result.outcome}`);
              })
            }
          >
            再取得
          </button>
        </div>
      )}

      {kind === 'done' && (
        <dl className="dispatch-card__done">
          {doneRowsOf(dispatch).map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      {canCancel(dispatch.status) && (
        <button
          type="button"
          className="dispatch-card__cancel"
          disabled={busy}
          onClick={() =>
            void runGate('この Dispatch を中止します。よろしいですか？', async () => {
              await api.cancelDispatch(dispatch.id, 'web UI から中止');
            })
          }
        >
          中止
        </button>
      )}
    </div>
  );
}
