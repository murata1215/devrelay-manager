#!/bin/bash
# council-lib.sh
#
# 協議オーケストレーション (Council Orchestration) v1 の純粋関数群。
# 仕様の Source of Truth は doc/council-orchestration-spec.md。
# ここに定義する関数は副作用を極力持たず（ファイル書き込みを除く）、
# council-run.sh から source して使う想定。tests/run-tests.sh から直接
# source してユニットテストすることも想定している。
#
# 依存: bash, jq
set -uo pipefail

# ハードキャップ: --max-rounds にどんな値を指定されても、この回数を超えて
# ループを回さない（無限ループ・premature done 対策の最終防衛線）。
# spec §1「安全弁」に対応。呼び出し側のオプションでは上書きできない定数。
readonly COUNCIL_HARD_CAP=10

##
# council_new_deliberation_id
#
# deliberationId を採番する（spec §4: v1 はスキーマ変更なし、本文ヘッダ埋め込み方式）。
# フォーマット: del_YYYYMMDD_HHMMSS_<4桁16進の短乱数>（JST基準）
#
# 引数: なし
# 標準出力: deliberationId 文字列（1行）
##
council_new_deliberation_id() {
  local ts
  ts=$(TZ=Asia/Tokyo date '+%Y%m%d_%H%M%S')
  local rand
  rand=$(printf '%04x' "$((RANDOM % 65536))")
  echo "del_${ts}_${rand}"
}

##
# council_meta_header
#
# 各 Message 本文の先頭に埋め込む COUNCIL_META ヘッダを1行生成する（spec §4）。
#
# 引数:
#   $1 deliberationId
#   $2 round（整数）
#   $3 ai（"claude" | "codex" 等）
#   $4 verdict（"approve" | "revise" | 空文字可。提案者ターンには verdict が無いため空文字を許容）
# 標準出力: `COUNCIL_META: {...}` の1行
##
council_meta_header() {
  local deliberation_id="$1" round="$2" ai="$3" verdict="${4:-}"
  local json
  json=$(jq -nc \
    --arg id "$deliberation_id" \
    --argjson round "$round" \
    --arg ai "$ai" \
    --arg verdict "$verdict" \
    '{deliberationId: $id, round: $round, ai: $ai, verdict: (if $verdict == "" then null else $verdict end)}')
  echo "COUNCIL_META: ${json}"
}

##
# council_parse_verdict
#
# codex の批評ターン本文から COUNCIL_VERDICT 行を決定的にパースする（spec §2）。
# 「LLM の自由判断に収束を委ねない」を守るため、パースはこの関数のみで完結させる。
#
# ルール:
#   - `^COUNCIL_VERDICT:\s*\{.*\}$` にマッチする行のうち、**最後**に出現したものを採用する
#     （批評本文中に例示や再掲があっても、末尾の1行を正とする）
#   - verdict は "approve" | "revise"、severity は "blocker" | "major" | "minor" | "nit"、
#     open は 0 以上の整数、のいずれかを満たさない場合は不正とみなす
#   - 行が見つからない、または不正な場合は fail-closed（非収束扱い）で
#     {"verdict":"revise","severity":"blocker","open":0,"parseError":true} を返す。
#     "verdict が読めない＝approve" は premature done の温床になるため採用しない。
#
# 引数: なし（標準入力から批評本文全体を読む）
# 標準出力: 正規化された verdict JSON（1行）
# 戻り値: 0=パース成功 / 1=パース失敗（fail-closed 値を出力した上で返す）
##
council_parse_verdict() {
  local body line last_match=""
  body=$(cat)

  while IFS= read -r line; do
    if [[ "$line" =~ ^COUNCIL_VERDICT:[[:space:]]*(\{.*\})[[:space:]]*$ ]]; then
      last_match="${BASH_REMATCH[1]}"
    fi
  done <<< "$body"

  if [ -z "$last_match" ]; then
    echo '{"verdict":"revise","severity":"blocker","open":0,"parseError":true}'
    return 1
  fi

  # jq でスキーマ検証（verdict/severity/open の値域チェック）
  local normalized
  normalized=$(echo "$last_match" | jq -c '
    if (.verdict as $v | ["approve","revise"] | index($v)) == null then
      {"valid": false}
    elif (.severity as $s | ["blocker","major","minor","nit"] | index($s)) == null then
      {"valid": false}
    elif ((.open | type) != "number") or (.open < 0) then
      {"valid": false}
    else
      {"valid": true, "verdict": .verdict, "severity": .severity, "open": .open}
    end
  ' 2>/dev/null) || normalized='{"valid":false}'

  local is_valid
  is_valid=$(echo "$normalized" | jq -r '.valid // false' 2>/dev/null)

  if [ "$is_valid" != "true" ]; then
    echo '{"verdict":"revise","severity":"blocker","open":0,"parseError":true}'
    return 1
  fi

  echo "$normalized" | jq -c '{verdict, severity, open, parseError: false}'
  return 0
}

##
# council_is_converged
#
# verdict JSON から収束/非収束を判定する（spec §2 収束バー）。
# 収束バー: verdict=approve、または blocker/major が0（= severity が minor/nit のみ残存）。
# parseError が立っている場合は severity の値に関わらず非収束として扱う（fail-closed）。
#
# 引数:
#   $1 council_parse_verdict の出力 JSON
# 戻り値: 0=収束 / 1=非収束
##
council_is_converged() {
  local verdict_json="$1"
  local parse_error verdict severity
  parse_error=$(echo "$verdict_json" | jq -r '.parseError // false')
  verdict=$(echo "$verdict_json" | jq -r '.verdict // ""')
  severity=$(echo "$verdict_json" | jq -r '.severity // ""')

  if [ "$parse_error" = "true" ]; then
    return 1
  fi
  if [ "$verdict" = "approve" ]; then
    return 0
  fi
  if [ "$severity" = "minor" ] || [ "$severity" = "nit" ]; then
    return 0
  fi
  return 1
}

##
# council_sum_usage
#
# usageData の配列を合算する（spec §5: 新規インフラ不要、usageData の再利用）。
# 各要素は {"inputTokens":N,"outputTokens":N} 形式を想定（欠損フィールドは0扱い）。
#
# 引数:
#   $1 usage レコードの JSON 配列（文字列 or ファイルパス。ファイルが存在すればファイルとして読む）
# 標準出力: 合計トークン数（整数、1行）
##
council_sum_usage() {
  local input="$1" data
  if [ -f "$input" ]; then
    data=$(cat "$input")
  else
    data="$input"
  fi
  echo "$data" | jq '[.[] | ((.inputTokens // 0) + (.outputTokens // 0))] | add // 0'
}

##
# council_strip_ask_preamble
#
# ask.sh の出力は「送信中...」等の前置き行 → `=== <名前> からの回答 ===` → 空行 → 本文、
# という構造になっている。本文だけを取り出す。
# `=== ... からの回答 ===` の行が見つからない場合は、入力全体をそのまま返す
# （mock や将来の出力形式変更に対するフォールバック）。
#
# 引数: なし（標準入力からask.sh相当の出力全体を読む）
# 標準出力: 本文のみ
##
council_strip_ask_preamble() {
  local body
  body=$(cat)
  if echo "$body" | grep -qE '^=== .+ からの回答 ===$'; then
    echo "$body" | awk '
      found { print; next }
      /^=== .+ からの回答 ===$/ { found=1; skip_blank=1; next }
    ' | awk 'NR==1 && $0=="" { next } { print }'
  else
    echo "$body"
  fi
}

##
# council_extract_open_issues
#
# 未収束時、最後の批評ターンから残論点（blocker/major のみ）を抽出する（spec §6）。
# 追加の LLM コールは行わない、というのが要件のため、批評本文の記法規約に依拠する:
#   `- [blocker] ...` / `- [major] ...`（先頭の `-`・`*` いずれも可、大小文字不問）
# という行のみを残論点として拾う。この記法規約は spec 未定義のため v1 実装の判断として
# ここに明記する（codex への指示プロンプト側でこの記法を使うよう誘導する運用とセット）。
#
# 引数: なし（標準入力から批評本文を読む）
# 標準出力: 該当行のみ（0件ならば空文字）
##
council_extract_open_issues() {
  grep -iE '^[[:space:]]*[-*][[:space:]]*\[(blocker|major)\]' || true
}

##
# council_detect_ais
#
# 利用可能な AI の一覧を判定する（spec §10 前提チェック）。
# 優先順位: 環境変数 COUNCIL_AIS（カンマ/空白区切りの明示指定）> ローカル CLI プローブ。
# CLI プローブは `claude` / `codex` の command -v の有無で判定する
# （リモートマシンの利用可能 AI を問い合わせる API が v1 時点で存在しないための代替手段）。
#
# 引数: なし
# 標準出力: 空白区切りの AI 名一覧（例: "claude codex"）。0件なら空文字。
##
council_detect_ais() {
  if [ -n "${COUNCIL_AIS:-}" ]; then
    echo "$COUNCIL_AIS" | tr ',' ' ' | xargs -n1 echo | sort -u | xargs
    return 0
  fi
  local found=()
  command -v claude &>/dev/null && found+=("claude")
  command -v codex &>/dev/null && found+=("codex")
  echo "${found[@]:-}"
}
