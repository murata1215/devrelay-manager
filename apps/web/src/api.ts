/**
 * manager API への薄い fetch ラッパ（サイクル1.18 ④-2）。
 *
 * エンドポイントごとに型を付け、失敗はすべて ApiError として throw する
 * （握り潰さず呼び出し側でエラー表示に使う）。
 */
import type {
  ThreadDto,
  MessageDto,
  DispatchDto,
  CoreProjectDto,
  DispatchPlanDto,
  OrchestrateResultDto,
  GateOutcomeDto,
} from './types.js';

/** API ベース URL。既定は manager サーバーのローカル既定ポート 3100。 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:3100';

/**
 * 認証未実装（層⑤で対応予定）のため、スレッド作成者を表す固定値。
 * apps/server の POST /threads が ownerId を必須にしているための暫定対応。
 */
const OWNER_ID = (import.meta.env.VITE_OWNER_ID as string | undefined) ?? 'web-local';

/** API 呼び出し失敗を表す例外。HTTP ステータスとサーバーの error メッセージを保持する。 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** レスポンス body から人間向けエラーメッセージを取り出す。形が不定でも極力読める文字列にする。 */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** 共通 fetch。非 2xx は ApiError を throw する。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // ネットワークエラー（サーバー未起動等）。コンソールに握り潰さず呼び出し側へ伝える。
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, `manager サーバーに到達できません: ${detail}`);
  }

  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(body, `HTTP ${res.status}`));
  }
  return body as T;
}

/** GET /threads — スレッド一覧（createdAt 降順）。 */
export function listThreads(): Promise<ThreadDto[]> {
  return request<ThreadDto[]>('/threads');
}

/** POST /threads — 新規スレッド作成。 */
export function createThread(title: string): Promise<ThreadDto> {
  return request<ThreadDto>('/threads', {
    method: 'POST',
    body: JSON.stringify({ title, ownerId: OWNER_ID }),
  });
}

/** GET /threads/:id/messages — メッセージ一覧（createdAt 昇順）。 */
export function listMessages(threadId: string): Promise<MessageDto[]> {
  return request<MessageDto[]>(`/threads/${threadId}/messages`);
}

/** POST /threads/:id/messages — メッセージ追記（orchestrate が使えないときのフォールバック用）。 */
export function createMessage(threadId: string, role: 'user' | 'manager', content: string): Promise<MessageDto> {
  return request<MessageDto>(`/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role, content }),
  });
}

/** GET /threads/:threadId/dispatches — スレッドに紐づく Dispatch 一覧（{dispatches:[...]} でラップされている）。 */
export async function listDispatches(threadId: string): Promise<DispatchDto[]> {
  const body = await request<{ dispatches: DispatchDto[] }>(`/threads/${threadId}/dispatches`);
  return body.dispatches;
}

/** GET /core/projects — core が持つプロジェクト一覧。 */
export function listProjects(): Promise<CoreProjectDto[]> {
  return request<CoreProjectDto[]>('/core/projects');
}

/**
 * POST /threads/:id/orchestrate — orchestrator LLM を1回呼ぶ。
 * このエンドポイントが user Message 行の作成まで面倒を見るため、
 * 呼び出し側で事前に POST /messages を叩いてはいけない（二重投稿になる）。
 */
export function orchestrate(threadId: string, content: string): Promise<OrchestrateResultDto> {
  return request<OrchestrateResultDto>(`/threads/${threadId}/orchestrate`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

/** GET /dispatch/:id/plan — ゲート②承認カード表示用にプラン本文を取り寄せる（副作用なし）。 */
export function getPlan(dispatchId: string): Promise<DispatchPlanDto> {
  return request<DispatchPlanDto>(`/dispatch/${dispatchId}/plan`);
}

/** POST /dispatch/:id/approve-target — ゲート①（投げ先の承認）。 */
export function approveTarget(dispatchId: string, instruction: string): Promise<{ ok: true; instruction: string }> {
  return request(`/dispatch/${dispatchId}/approve-target`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
}

/** POST /dispatch/:id/approve-plan — ゲート②（プランの承認・実行開始）。 */
export function approvePlan(dispatchId: string): Promise<GateOutcomeDto> {
  return request(`/dispatch/${dispatchId}/approve-plan`, { method: 'POST', body: '{}' });
}

/** POST /dispatch/:id/retry-stale — stale 状態からの再取得。 */
export function retryStale(dispatchId: string): Promise<GateOutcomeDto> {
  return request(`/dispatch/${dispatchId}/retry-stale`, { method: 'POST', body: '{}' });
}

/** POST /dispatch/:id/cancel — 非終端状態の中止。reason は必須。 */
export function cancelDispatch(dispatchId: string, reason: string): Promise<{ ok: true }> {
  return request(`/dispatch/${dispatchId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}
