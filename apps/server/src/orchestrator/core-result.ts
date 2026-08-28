/**
 * core RPC の応答分類（サイクル1.8 ③-2）。
 *
 * 純粋モジュール：import ゼロ。core（get_plan / get_build_status）の応答語彙は、
 * 実際に build を走らせないと全網羅を確認できない（③-2 は非スコープでビルドを
 * 起こさない）。そのため分類器は必ず 'unknown' を持ち、判定できない応答を
 * 成功にも失敗にも倒さない（no-silent-failure の反転を避ける）。
 * 'unknown' を受け取った worker 側は状態を遷移させず、次のポーリングに委ねる
 * （最終的にはバジェット枯渇で stopped になり、人間に理由が提示される）。
 *
 * 実測（core への読み取り専用プローブ、サイクル1.8 ③-2 devlog 参照）:
 * - getPlan(存在しない submissionId) は resolve して
 *   {"status":"not_found","error":"Submission not found"} を返す。
 *   → not_found が submission 生存確認の唯一の健全なオラクル（staleCheck の根拠）。
 * - getBuildStatus(存在しない submissionId) は resolve して
 *   {"phase":"queued","done":false} を返す。
 *   → 存在確認には使えない（未知IDにも queued を返すため）。
 */

export type PlanResultKind = 'ready' | 'pending' | 'not_found' | 'error' | 'unknown';

export interface ClassifiedPlanResult {
  kind: PlanResultKind;
  planMarkdown?: string;
}

export type BuildResultKind = 'running' | 'succeeded' | 'failed' | 'unknown';

export interface ClassifiedBuildResult {
  kind: BuildResultKind;
  buildId?: string;
  summary?: string;
  devlogPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** get_plan の生応答を分類する。 */
export function classifyPlanResult(raw: unknown): ClassifiedPlanResult {
  if (!isRecord(raw) || typeof raw.status !== 'string') {
    return { kind: 'unknown' };
  }
  const status = raw.status;

  if (status === 'not_found') {
    return { kind: 'not_found' };
  }
  if (status === 'error') {
    return { kind: 'error' };
  }
  if (status === 'planning' || status === 'pending') {
    return { kind: 'pending' };
  }
  if (status === 'ready' || status === 'done' || status === 'completed') {
    const planMarkdown = typeof raw.planMarkdown === 'string' ? raw.planMarkdown : undefined;
    return { kind: 'ready', planMarkdown };
  }
  // 未知の status 語彙。成功・失敗どちらにも倒さない。
  return { kind: 'unknown' };
}

/**
 * サイクル1.19 S4/S5: devlog パスのフィールド名は未確認（実 build で確認できていない）。
 * devlogPath -> devlog_path -> devlog の順で最初に見つかった string を寛容に採用する。
 */
function extractDevlogPath(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.devlogPath === 'string') return raw.devlogPath;
  if (typeof raw.devlog_path === 'string') return raw.devlog_path;
  if (typeof raw.devlog === 'string') return raw.devlog;
  return undefined;
}

/** get_build_status の生応答を分類する。 */
export function classifyBuildResult(raw: unknown): ClassifiedBuildResult {
  if (!isRecord(raw)) {
    return { kind: 'unknown' };
  }

  const done = raw.done;
  const buildId = typeof raw.buildId === 'string' ? raw.buildId : undefined;
  const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
  const devlogPath = extractDevlogPath(raw);

  if (typeof done !== 'boolean') {
    // done フィールド自体が欠落・型不正 = 応答が想定形をしていない。判定不能。
    return { kind: 'unknown', buildId, summary, devlogPath };
  }

  if (done === false) {
    // {"phase":"queued","done":false} のような実測応答を含む。done:false な限り
    // phase の語彙は問わず running 扱いにする（queued/building/... を列挙化しない）。
    return { kind: 'running', buildId, summary, devlogPath };
  }

  // done === true。成否を phase / success 系フィールドから判定する。
  const phase = typeof raw.phase === 'string' ? raw.phase : undefined;
  const success = typeof raw.success === 'boolean' ? raw.success : undefined;

  if (success === true || phase === 'succeeded' || phase === 'success' || phase === 'done') {
    return { kind: 'succeeded', buildId, summary, devlogPath };
  }
  if (success === false || phase === 'failed' || phase === 'error') {
    return { kind: 'failed', buildId, summary, devlogPath };
  }
  // done:true だが成否を示すフィールドが未知の語彙。判定不能。
  return { kind: 'unknown', buildId, summary, devlogPath };
}
