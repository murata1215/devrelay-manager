/**
 * repo 推定（提案）ロジックのローカル型と自己ループ検出（サイクル1.11 ③-3）。
 *
 * spec §7: list_projects（online 含む）＋名前/別名マッチ＋直近スレ文脈の合わせ技で
 * 候補を出し、常に「提案」に留める（決めるのは人間）。
 *
 * このファイルは core の型（coreClient.CoreProject 等）を一切 import しない。
 * ProjectCandidate は呼び出し側（routes/orchestrator.ts）が CoreProject から詰め替えた
 * ローカルの素データ型であり、orchestrator-llm.ts / project-proposal.ts が coreClient や
 * core RPC に触れる経路を持たないことの一部（import 禁止リスト参照）。
 *
 * 純粋モジュール：import ゼロ。
 */

export interface ProjectCandidate {
  projectId: string;
  name: string;
  path: string;
  machine: string;
  online: boolean;
}

export interface AnnotatedCandidate extends ProjectCandidate {
  selfLoopWarning: boolean;
  /** selfLoopWarning が true のときのみ設定される、人間に提示する警告文。 */
  warningText?: string;
}

/**
 * サイクル1.9 の実測を引いた自己ループ警告文。
 * 1.9 devlog（doc/devlog/2026-08-25_075519.md）: 投げ先が manager 自身のリポジトリに
 * 解決されたため、core は独立したプロセスを立てず実行中セッションの plan ファイルへ
 * 注入する形で処理し、building で足踏みした。
 */
export const SELF_LOOP_WARNING_TEXT =
  'この候補は orchestrator（manager）自身が動いているリポジトリです。' +
  'サイクル1.9 の実測では、投げ先がここに解決された結果、core が独立したプロセスを立てず' +
  '実行中セッションへ注入する形になり、building で足踏みしました（自己ループ）。' +
  '意図的でなければ別の候補を選んでください。';

/** パスを比較用に正規化する（末尾スラッシュ除去のみ。シンボリックリンク解決等はしない）。 */
function normalizePath(path: string): string {
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

/** candidatePath が managerRepoPath 自身か、その配下（サブパス）かを判定する。 */
export function detectSelfLoop(candidatePath: string, managerRepoPath: string): boolean {
  const candidate = normalizePath(candidatePath);
  const manager = normalizePath(managerRepoPath);
  return candidate === manager || candidate.startsWith(manager + '/');
}

/** 候補一覧に自己ループ警告を付ける。候補からの除外はしない（決めるのは人間。spec §9）。 */
export function annotateCandidates(
  candidates: readonly ProjectCandidate[],
  managerRepoPath: string
): AnnotatedCandidate[] {
  return candidates.map((c) => {
    const selfLoop = detectSelfLoop(c.path, managerRepoPath);
    return selfLoop
      ? { ...c, selfLoopWarning: true, warningText: SELF_LOOP_WARNING_TEXT }
      : { ...c, selfLoopWarning: false };
  });
}
