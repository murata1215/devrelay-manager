#!/bin/bash
# run-tests.sh
#
# 外部依存（bats/shellcheck 等）なしの自作テストランナー。
# council-lib.sh のユニットテストと、council-run.sh を mock-ask.sh 経由で
# 実行する結合テストを行う。ネットワーク・実 codex は一切呼ばない。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIB="${REPO_ROOT}/scripts/lib/council-lib.sh"
RUN="${REPO_ROOT}/scripts/council-run.sh"
MOCK="${SCRIPT_DIR}/mock-ask.sh"
FIXTURES="${SCRIPT_DIR}/fixtures"

# shellcheck source=../scripts/lib/council-lib.sh
source "$LIB"

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ok - ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  NG - ${desc} (expected=[${expected}] actual=[${actual}])"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1))
    echo "  ok - ${desc}"
  else
    FAIL=$((FAIL + 1))
    echo "  NG - ${desc} (needle not found: [${needle}])"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1))
    echo "  NG - ${desc} (needle unexpectedly found: [${needle}])"
  else
    PASS=$((PASS + 1))
    echo "  ok - ${desc}"
  fi
}

echo "=== 1. COUNCIL_VERDICT パーサ（8 fixture） ==="
declare -A EXP_VERDICT=(
  [verdict-approve.txt]="approve" [verdict-blocker.txt]="revise"
  [verdict-major.txt]="revise" [verdict-minor.txt]="revise"
  [verdict-nit.txt]="revise" [verdict-missing.txt]="revise"
  [verdict-broken-json.txt]="revise" [verdict-multiple.txt]="approve"
)
declare -A EXP_SEVERITY=(
  [verdict-approve.txt]="nit" [verdict-blocker.txt]="blocker"
  [verdict-major.txt]="major" [verdict-minor.txt]="minor"
  [verdict-nit.txt]="nit" [verdict-missing.txt]="blocker"
  [verdict-broken-json.txt]="blocker" [verdict-multiple.txt]="nit"
)
declare -A EXP_PARSE_ERROR=(
  [verdict-approve.txt]="false" [verdict-blocker.txt]="false"
  [verdict-major.txt]="false" [verdict-minor.txt]="false"
  [verdict-nit.txt]="false" [verdict-missing.txt]="true"
  [verdict-broken-json.txt]="true" [verdict-multiple.txt]="false"
)
for f in verdict-approve.txt verdict-blocker.txt verdict-major.txt verdict-minor.txt \
         verdict-nit.txt verdict-missing.txt verdict-broken-json.txt verdict-multiple.txt; do
  RESULT=$(council_parse_verdict < "${FIXTURES}/${f}")
  V=$(echo "$RESULT" | jq -r '.verdict')
  S=$(echo "$RESULT" | jq -r '.severity')
  P=$(echo "$RESULT" | jq -r '.parseError')
  assert_eq "${f}: verdict" "${EXP_VERDICT[$f]}" "$V"
  assert_eq "${f}: severity" "${EXP_SEVERITY[$f]}" "$S"
  assert_eq "${f}: parseError" "${EXP_PARSE_ERROR[$f]}" "$P"
done

echo ""
echo "=== 2. 収束判定（council_is_converged） ==="
declare -A EXP_CONVERGED=(
  [verdict-approve.txt]="0" [verdict-blocker.txt]="1"
  [verdict-major.txt]="1" [verdict-minor.txt]="0"
  [verdict-nit.txt]="0" [verdict-missing.txt]="1"
  [verdict-broken-json.txt]="1" [verdict-multiple.txt]="0"
)
for f in "${!EXP_CONVERGED[@]}"; do
  RESULT=$(council_parse_verdict < "${FIXTURES}/${f}")
  council_is_converged "$RESULT"
  RC=$?
  assert_eq "${f}: is_converged rc" "${EXP_CONVERGED[$f]}" "$RC"
done

echo ""
echo "=== 3. ループ終了条件（council-run.sh 結合テスト） ==="

WORKDIR=$(mktemp -d)
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

run_council() {
  # 標準出力とexit codeをグローバル変数に格納するヘルパー
  COUNCIL_OUT=$("$@" 2>"${WORKDIR}/stderr.log")
  COUNCIL_RC=$?
}

# 3a: 1ラウンドで収束（approve）
COUNTER="${WORKDIR}/counter-3a"; rm -f "$COUNTER"
LOGDIR_3A="${WORKDIR}/logs-3a"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-approve.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_3A" --max-rounds 4
assert_contains "3a: 1ラウンドで収束" "$COUNCIL_OUT" "収束ステータス: converged"
assert_contains "3a: 実行ラウンド数=1" "$COUNCIL_OUT" "実行ラウンド数: 1"

# 3b: blocker→approve で2ラウンド目に収束
COUNTER="${WORKDIR}/counter-3b"; rm -f "$COUNTER"
LOGDIR_3B="${WORKDIR}/logs-3b"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt,${FIXTURES}/verdict-approve.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_3B" --max-rounds 4
assert_contains "3b: 2ラウンド目で収束" "$COUNCIL_OUT" "収束ステータス: converged"
assert_contains "3b: 実行ラウンド数=2" "$COUNCIL_OUT" "実行ラウンド数: 2"

# 3c: blocker が続き max-rounds で強制終了
COUNTER="${WORKDIR}/counter-3c"; rm -f "$COUNTER"
LOGDIR_3C="${WORKDIR}/logs-3c"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_3C" --max-rounds 2
assert_contains "3c: max_rounds で強制終了" "$COUNCIL_OUT" "収束ステータス: max_rounds"
assert_contains "3c: 実行ラウンド数=2で打ち切り" "$COUNCIL_OUT" "実行ラウンド数: 2"
assert_contains "3c: 残論点にblockerが含まれる" "$COUNCIL_OUT" "[blocker]"

# 3d: --max-rounds がハードキャップ超過なら即エラー
set +e
bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --max-rounds 99 >"${WORKDIR}/3d.out" 2>"${WORKDIR}/3d.err"
RC_3D=$?
set -e 2>/dev/null || true
assert_eq "3d: max-rounds超過は exit 1" "1" "$RC_3D"
assert_contains "3d: エラーメッセージにハードキャップ言及" "$(cat "${WORKDIR}/3d.err")" "10"

echo ""
echo "=== 4. コスト合算 ==="

# 4a: usage-file 指定時、2ラウンド分が正しく合算される（期待値 3020）
COUNTER="${WORKDIR}/counter-4a"; rm -f "$COUNTER"
LOGDIR_4A="${WORKDIR}/logs-4a"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt,${FIXTURES}/verdict-blocker.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_4A" --max-rounds 2 --usage-file "${FIXTURES}/usage-sample.json"
assert_contains "4a: 合計コスト=3020" "$COUNCIL_OUT" "合計コスト（トークン）: 3020"

# 4b: cost-limit 超過で1ラウンド目に停止（cost_limit）
COUNTER="${WORKDIR}/counter-4b"; rm -f "$COUNTER"
LOGDIR_4B="${WORKDIR}/logs-4b"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt,${FIXTURES}/verdict-blocker.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_4B" --max-rounds 4 --usage-file "${FIXTURES}/usage-sample.json" --cost-limit 1000
assert_contains "4b: cost_limit で停止" "$COUNCIL_OUT" "収束ステータス: cost_limit"
assert_contains "4b: 1ラウンド目で停止（合計1400）" "$COUNCIL_OUT" "合計コスト（トークン）: 1400"

echo ""
echo "=== 5. --council 省略時は後方互換（通常フロー不変） ==="
CALL_LOG_5="${WORKDIR}/calls-5.log"; rm -f "$CALL_LOG_5"
MOCK_CALL_LOG="$CALL_LOG_5" MOCK_SINGLE_FILE="${FIXTURES}/proposal-1.txt" \
  run_council bash "$RUN" --project t --topic "テスト議題" --ask-cmd "$MOCK"
CALL_COUNT_5=$(wc -l < "$CALL_LOG_5" | tr -d ' ')
assert_eq "5: ask呼び出しは1回のみ" "1" "$CALL_COUNT_5"
assert_contains "5: 出力はask.sh互換の生出力（前置き含む）" "$COUNCIL_OUT" "=== mock からの回答 ==="
assert_eq "5: exit code 0" "0" "$COUNCIL_RC"

echo ""
echo "=== 6. AI 2種未満で静かにフォールバック ==="
CALL_LOG_6="${WORKDIR}/calls-6.log"; rm -f "$CALL_LOG_6"
COUNCIL_AIS="claude" MOCK_CALL_LOG="$CALL_LOG_6" MOCK_SINGLE_FILE="${FIXTURES}/proposal-1.txt" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK"
CALL_COUNT_6=$(wc -l < "$CALL_LOG_6" | tr -d ' ')
assert_eq "6: --council指定でもAI1種ならask呼び出しは1回のみ" "1" "$CALL_COUNT_6"
assert_not_contains "6: 警告文言なし" "$COUNCIL_OUT" "警告"
assert_not_contains "6: エラー文言なし" "$COUNCIL_OUT" "エラー"
assert_eq "6: exit code 0" "0" "$COUNCIL_RC"

echo ""
echo "=== 7. 人間への提示は最終1回のみ（途中ラウンド非表示） ==="
COUNTER="${WORKDIR}/counter-7"; rm -f "$COUNTER"
LOGDIR_7="${WORKDIR}/logs-7"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt,${FIXTURES}/verdict-approve.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_7" --max-rounds 4
HEADER_COUNT_7=$(echo "$COUNCIL_OUT" | grep -c "=== Council 結果 ===")
assert_eq "7: 結果ヘッダは1回のみ出力" "1" "$HEADER_COUNT_7"
assert_not_contains "7: verboseマーカーが出ない(non-verbose)" "$COUNCIL_OUT" "round 1 開始"

echo ""
echo "=== 8. Council ログ生成（1ターン1ファイル） ==="
COUNTER="${WORKDIR}/counter-8"; rm -f "$COUNTER"
LOGDIR_8="${WORKDIR}/logs-8"
COUNCIL_AIS="claude,codex" MOCK_PROPOSAL_FILE="${FIXTURES}/proposal-1.txt" \
  MOCK_CRITIQUE_SEQUENCE="${FIXTURES}/verdict-blocker.txt,${FIXTURES}/verdict-approve.txt" MOCK_COUNTER_FILE="$COUNTER" \
  run_council bash "$RUN" --project t --topic "テスト議題" --council --ask-cmd "$MOCK" --log-dir "$LOGDIR_8" --max-rounds 4
FILE_COUNT_8=$(find "$LOGDIR_8" -type f -name '*.md' | wc -l | tr -d ' ')
# 2ラウンド × (提案者+批評者) = 4ファイル
assert_eq "8: ログファイル数=4（2ラウンド×2ターン）" "4" "$FILE_COUNT_8"
NAMING_OK=1
for f in "$LOGDIR_8"/*.md; do
  bn=$(basename "$f")
  if ! [[ "$bn" =~ ^[0-9]{8}_[0-9]{6}_del_[0-9]{8}_[0-9]{6}_[0-9a-f]{4}_(claude|codex)_r[0-9]+\.md$ ]]; then
    NAMING_OK=0
  fi
done
assert_eq "8: ファイル名が命名規則に従う" "1" "$NAMING_OK"

echo ""
echo "=== 結果: ${PASS} passed, ${FAIL} failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
