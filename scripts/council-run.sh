#!/bin/bash
# council-run.sh
#
# 協議オーケストレーション (Council Orchestration) v1 のループ駆動スクリプト。
# 仕様の Source of Truth は doc/council-orchestration-spec.md。
# ask.sh（プランモードのクロス AI 問い合わせ）を決定的にラップし、
# claude=提案者/プラン所有者、codex=批評者/検証者、の固定役割で逐次ラリーを回す。
#
# 【重要な設計方針（spec 準拠）】
# - 協議はデフォルト OFF。--council を明示した時のみ発火する（spec §10）。
# - --council 指定時でも、利用可能な AI が2種未満なら、エラーにせず静かに
#   通常の単一 AI フローへフォールバックする（spec §10）。
# - 人間への提示は最終1回のみ。途中ラウンドは（--verbose 指定時を除き）出力しない（spec §8）。
# - ラウンド計数・verdict パース・コスト合算は本スクリプト（コード側）が決定的に行い、
#   LLM の自由判断に委ねない（spec §2, §3）。
#
# 依存: bash, jq, curl（ask.sh 経由）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/council-lib.sh
source "${SCRIPT_DIR}/lib/council-lib.sh"

# ---- デフォルト値 ----
PROJECT=""
TOPIC=""
COUNCIL_MODE=0
MAX_ROUNDS=4
COST_LIMIT=0          # 0 = 上限なし
PROPOSER="claude"
CRITIC="codex"
ASK_CMD="${HOME}/.claude/skills/devrelay-ask-member/scripts/ask.sh"
USAGE_FILE=""         # 指定時のみコスト合算にfixtureを使う（spec §5: ライブ結線は次サイクル）
LOG_DIR=""
VERBOSE=0
DRY_RUN=0

usage() {
  cat <<'EOF'
使い方:
  council-run.sh --project <名前> --topic "<議題>" [--council]
                  [--max-rounds N] [--cost-limit N]
                  [--proposer <ai>] [--critic <ai>]
                  [--ask-cmd <path>] [--usage-file <path>]
                  [--log-dir <dir>] [--verbose] [--dry-run]

--council を指定しない場合、通常の単一 AI 問い合わせ（ask.sh 1回呼び出し）のみを行う
（後方互換。既存の ask フローの挙動を一切変えない）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --topic) TOPIC="$2"; shift 2 ;;
    --council) COUNCIL_MODE=1; shift ;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2 ;;
    --cost-limit) COST_LIMIT="$2"; shift 2 ;;
    --proposer) PROPOSER="$2"; shift 2 ;;
    --critic) CRITIC="$2"; shift 2 ;;
    --ask-cmd) ASK_CMD="$2"; shift 2 ;;
    --usage-file) USAGE_FILE="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "エラー: 不明な引数: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] || [ -z "$TOPIC" ]; then
  echo "エラー: --project と --topic は必須です" >&2
  exit 1
fi

# --max-rounds の値域チェック（不正指定は即エラー。ハードキャップは council-lib.sh 側の定数）
if ! [[ "$MAX_ROUNDS" =~ ^[0-9]+$ ]] || [ "$MAX_ROUNDS" -lt 1 ] || [ "$MAX_ROUNDS" -gt "$COUNCIL_HARD_CAP" ]; then
  echo "エラー: --max-rounds は 1〜${COUNCIL_HARD_CAP} の整数で指定してください（指定値: ${MAX_ROUNDS}）" >&2
  exit 1
fi

if [ -z "$LOG_DIR" ]; then
  LOG_DIR="doc/council/${PROJECT}"
fi

log_verbose() {
  [ "$VERBOSE" = "1" ] && echo "[council-run] $*" >&2
  return 0
}

##
# call_ask
#
# ask.sh（または --ask-cmd で注入されたモック）を呼び出し、標準出力の本文のみを返す。
# 引数:
#   $1 ai（"claude" | "codex"）
#   $2 question（送信する質問文）
# 標準出力: 本文（前置き除去済み）
# 戻り値: ask.sh の exit code をそのまま伝播
##
call_ask() {
  local ai="$1" question="$2"
  local raw rc
  raw=$(bash "$ASK_CMD" --project "$PROJECT" --ai "$ai" --question "$question" 2>&1)
  rc=$?
  echo "$raw" | council_strip_ask_preamble
  return $rc
}

##
# write_council_log
#
# spec §7: 1ターン=1ファイルで council ログを保存する。
# 命名は spec §7 の `<timestamp>_<deliberationId>_<ai>.md` を基本としつつ、
# 秒精度のタイムスタンプでは同一秒内に複数ラウンドが走ると衝突しうるため、
# 実装上の安全策として round をファイル名に追加する（deliberationId・ai は
# spec 通りそのまま含む。ログ内容の構造は spec 通り 入力/出力 のみ）。
# 引数: $1 deliberationId, $2 round, $3 ai, $4 input, $5 output
##
write_council_log() {
  local deliberation_id="$1" round="$2" ai="$3" input="$4" output="$5"
  mkdir -p "$LOG_DIR"
  local ts file
  ts=$(TZ=Asia/Tokyo date '+%Y%m%d_%H%M%S')
  file="${LOG_DIR}/${ts}_${deliberation_id}_${ai}_r${round}.md"
  {
    echo "# Council Turn: round ${round} / ${ai}"
    echo ""
    echo "## Input"
    echo '```'
    echo "$input"
    echo '```'
    echo ""
    echo "## Output"
    echo '```'
    echo "$output"
    echo '```'
  } > "$file"
  echo "$file"
}

##
# run_single_ai_fallback
#
# --council 未指定時、または AI が2種未満で静かにフォールバックする時の経路。
# 既存の単一 AI プラン/exec フロー（ask.sh 1回呼び出し）をそのまま実行する。
# spec §10: フォールバックはエラー扱いにせず、警告も出さない。
##
run_single_ai_fallback() {
  bash "$ASK_CMD" --project "$PROJECT" --ai "$PROPOSER" --question "$TOPIC"
}

# ---- エントリポイント ----

if [ "$COUNCIL_MODE" != "1" ]; then
  log_verbose "--council 未指定のため通常の単一 AI フローで実行します"
  run_single_ai_fallback
  exit $?
fi

AVAILABLE_AIS=$(council_detect_ais)
AI_COUNT=$(echo "$AVAILABLE_AIS" | wc -w | tr -d ' ')

if [ "$AI_COUNT" -lt 2 ]; then
  # spec §10: 前提が揃わない場合は静かに通常フローへ（エラー扱い・警告なし）
  log_verbose "利用可能な AI が ${AI_COUNT} 種のため、静かに通常フローへフォールバックします"
  run_single_ai_fallback
  exit $?
fi

if [ "$DRY_RUN" = "1" ]; then
  jq -n \
    --arg project "$PROJECT" --arg topic "$TOPIC" \
    --arg proposer "$PROPOSER" --arg critic "$CRITIC" \
    --argjson maxRounds "$MAX_ROUNDS" --argjson costLimit "$COST_LIMIT" \
    --arg ais "$AVAILABLE_AIS" \
    '{dryRun: true, project: $project, topic: $topic, proposer: $proposer, critic: $critic, maxRounds: $maxRounds, costLimit: $costLimit, availableAis: $ais}'
  exit 0
fi

DELIBERATION_ID=$(council_new_deliberation_id)
log_verbose "deliberationId=${DELIBERATION_ID} を採番しました"

ROUND=1
LAST_PROPOSAL=""
LAST_CRITIQUE=""
LAST_VERDICT_JSON='{}'
STATUS="max_rounds"
LOG_FILES=()
USAGE_RECORDS="[]"
TOTAL_COST=0

EXECUTED_ROUNDS=0
while [ "$ROUND" -le "$MAX_ROUNDS" ] && [ "$ROUND" -le "$COUNCIL_HARD_CAP" ]; do
  log_verbose "=== round ${ROUND} 開始 ==="
  # ループが while 条件で自然終了（max_rounds 到達）した場合、ROUND はブレークせず
  # 最後にインクリメントされてしまうため、「実際に実行したラウンド数」を別途記録する。
  EXECUTED_ROUNDS=$ROUND

  # --- 提案者ターン（claude）---
  if [ "$ROUND" -eq 1 ]; then
    PROPOSER_Q="$TOPIC"
  else
    PROPOSER_Q="[議題]
${TOPIC}

[直近の提案]
${LAST_PROPOSAL}

[直近の批評]
${LAST_CRITIQUE}

上記の批評を踏まえてプランを改訂してください。あなたがプランの所有者です。"
  fi

  PROPOSAL=$(call_ask "$PROPOSER" "$PROPOSER_Q")
  META=$(council_meta_header "$DELIBERATION_ID" "$ROUND" "$PROPOSER" "")
  LOGFILE=$(write_council_log "$DELIBERATION_ID" "$ROUND" "$PROPOSER" "$PROPOSER_Q" "${META}
${PROPOSAL}")
  LOG_FILES+=("$LOGFILE")
  log_verbose "提案者ターン完了 → ${LOGFILE}"

  # --- 批評者ターン（codex）---
  CRITIC_Q="[議題]
${TOPIC}

[提案]
${PROPOSAL}

この提案を批評してください。あなたは対案（修正プラン本体）を書かず、指摘のみを行ってください。
必ず最後に以下の形式で1行、機械可読の判定を出力してください:
COUNCIL_VERDICT: {\"verdict\":\"approve|revise\",\"severity\":\"blocker|major|minor|nit\",\"open\":<件数>}"

  CRITIQUE=$(call_ask "$CRITIC" "$CRITIC_Q")
  VERDICT_JSON=$(echo "$CRITIQUE" | council_parse_verdict)
  META=$(council_meta_header "$DELIBERATION_ID" "$ROUND" "$CRITIC" "$(echo "$VERDICT_JSON" | jq -r '.verdict')")
  LOGFILE=$(write_council_log "$DELIBERATION_ID" "$ROUND" "$CRITIC" "$CRITIC_Q" "${META}
${CRITIQUE}")
  LOG_FILES+=("$LOGFILE")
  log_verbose "批評者ターン完了 → ${LOGFILE} / verdict=${VERDICT_JSON}"

  # --- コスト合算（spec §5）---
  # v1: --usage-file が指定された場合のみ、fixture ベースで合算する。
  # ライブの usageData 取得（GET /api/agent/messages）は codex 週間上限解除後の
  # 次サイクルで結線する（devrelay-manager の API トークンをこのリポジトリに
  # 複製しないため、ここでは合算ロジックのみを実装し検証する）。
  if [ -n "$USAGE_FILE" ]; then
    ROUND_USAGE=$(jq -c --argjson r "$ROUND" '[.[] | select(.round == $r)]' "$USAGE_FILE")
    USAGE_RECORDS=$(echo "$USAGE_RECORDS" "$ROUND_USAGE" | jq -sc 'add')
    TOTAL_COST=$(council_sum_usage "$USAGE_RECORDS")
    log_verbose "コスト合算: round=${ROUND} 時点の合計 = ${TOTAL_COST}"
    if [ "$COST_LIMIT" -gt 0 ] && [ "$TOTAL_COST" -ge "$COST_LIMIT" ]; then
      STATUS="cost_limit"
      LAST_PROPOSAL="$PROPOSAL"
      LAST_CRITIQUE="$CRITIQUE"
      LAST_VERDICT_JSON="$VERDICT_JSON"
      break
    fi
  fi

  LAST_PROPOSAL="$PROPOSAL"
  LAST_CRITIQUE="$CRITIQUE"
  LAST_VERDICT_JSON="$VERDICT_JSON"

  if council_is_converged "$VERDICT_JSON"; then
    STATUS="converged"
    break
  fi

  ROUND=$((ROUND + 1))
done

OPEN_ISSUES=""
if [ "$STATUS" != "converged" ]; then
  OPEN_ISSUES=$(echo "$LAST_CRITIQUE" | council_extract_open_issues)
fi

# ---- 人間への最終成果物（spec §8: 途中ラウンドは提示せず、ここで1回のみ）----
echo "=== Council 結果 ==="
echo "deliberationId: ${DELIBERATION_ID}"
echo "実行ラウンド数: ${EXECUTED_ROUNDS}"
echo "合計コスト（トークン）: ${TOTAL_COST}"
echo "収束ステータス: ${STATUS}"
echo ""
echo "--- 最終提案 ---"
echo "$LAST_PROPOSAL"
if [ -n "$OPEN_ISSUES" ]; then
  echo ""
  echo "--- 残論点（blocker/major） ---"
  echo "$OPEN_ISSUES"
fi
echo ""
echo "--- Council ログ ---"
for f in "${LOG_FILES[@]}"; do
  echo "  - $f"
done

exit 0
