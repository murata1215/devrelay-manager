#!/bin/bash
# mock-ask.sh
#
# devrelay-ask-member/scripts/ask.sh 互換のモック。
# ネットワーク・実 AI（claude/codex）を一切呼ばず、council-run.sh の
# --ask-cmd 注入点に差し込んでテストするために使う。
#
# 制御用の環境変数:
#   MOCK_CALL_LOG        呼び出しごとに "ai=... project=..." を1行追記するファイル
#   MOCK_PROPOSER_AI      提案者役として扱う --ai の値（既定 claude）
#   MOCK_CRITIC_AI         批評者役として扱う --ai の値（既定 codex）
#   MOCK_PROPOSAL_FILE     提案者ターンで返す本文のファイルパス
#   MOCK_CRITIQUE_SEQUENCE 批評者ターンで順番に返す本文ファイルパスのカンマ区切りリスト
#                          （呼び出し回数が超過したら最後の要素を繰り返す）
#   MOCK_COUNTER_FILE      批評者ターンの呼び出し回数を記録するファイル（ラウンド判定用）
#   MOCK_SINGLE_FILE       --council 未指定（単一AI）経路で返す本文のファイルパス
set -euo pipefail

PROJECT="" AI="" QUESTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    --ai) AI="$2"; shift 2 ;;
    --machine) shift 2 ;;
    --exec) shift ;;
    *) echo "mock-ask: unknown arg $1" >&2; exit 1 ;;
  esac
done

if [ -n "${MOCK_CALL_LOG:-}" ]; then
  echo "ai=${AI} project=${PROJECT}" >> "$MOCK_CALL_LOG"
fi

# ask.sh 実物と同じ「前置き → === ... からの回答 === → 空行 → 本文」を模倣する。
# council_strip_ask_preamble のテストも兼ねる。
emit() {
  local body="$1"
  echo "📨 mock (${PROJECT}) に質問を送信中..."
  echo "質問: (省略)"
  echo "(タイムアウト: 600秒)"
  echo ""
  echo "=== mock からの回答 ==="
  echo ""
  echo "$body"
}

PROPOSER_AI="${MOCK_PROPOSER_AI:-claude}"
CRITIC_AI="${MOCK_CRITIC_AI:-codex}"

if [ "$AI" = "$PROPOSER_AI" ]; then
  if [ -n "${MOCK_PROPOSAL_FILE:-}" ] && [ -f "$MOCK_PROPOSAL_FILE" ]; then
    emit "$(cat "$MOCK_PROPOSAL_FILE")"
  else
    emit "デフォルトの提案本文です。"
  fi
elif [ "$AI" = "$CRITIC_AI" ]; then
  IDX=1
  if [ -n "${MOCK_COUNTER_FILE:-}" ]; then
    if [ -f "$MOCK_COUNTER_FILE" ]; then
      IDX=$(( $(cat "$MOCK_COUNTER_FILE") + 1 ))
    fi
    echo "$IDX" > "$MOCK_COUNTER_FILE"
  fi
  if [ -n "${MOCK_CRITIQUE_SEQUENCE:-}" ]; then
    IFS=',' read -ra FILES <<< "$MOCK_CRITIQUE_SEQUENCE"
    N=${#FILES[@]}
    if [ "$IDX" -gt "$N" ]; then
      PICK="${FILES[$((N-1))]}"
    else
      PICK="${FILES[$((IDX-1))]}"
    fi
    emit "$(cat "$PICK")"
  else
    emit "デフォルトの批評本文です。
COUNCIL_VERDICT: {\"verdict\":\"approve\",\"severity\":\"nit\",\"open\":0}"
  fi
else
  if [ -n "${MOCK_SINGLE_FILE:-}" ] && [ -f "$MOCK_SINGLE_FILE" ]; then
    emit "$(cat "$MOCK_SINGLE_FILE")"
  else
    emit "デフォルトの単一AI回答です。"
  fi
fi
