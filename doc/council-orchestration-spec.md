# 協議オーケストレーション設計 (Council Orchestration) — v1 Spec

> deliberationId ベースの claude↔codex 逐次協議。プランモード内で完結し、収束結果を人間承認ゲートに乗せる。

## 0. 位置づけ・大前提

協議ラリー（claude↔codex）は最初から最後まで **プランモード内で完結** する。両者は調査・提案・批評のみを行い、コード変更・exec は行わない。

収束した成果物は「強化されたプラン」であり、それが **人間の承認ゲート** に乗る。承認されて初めて通常の DevRelay exec になる（そこにも既存の Plan/Exec 承認ゲートがある）。

**帰結:** 協議機構そのものは write / exec 権限を一切必要としない。構造的に安全であり、「協議が暴走してコードを書いた」が原理的に起きない。協議は既存 Plan/Exec ゲートの **前段に噛ませるアドオン** と位置づける。

## 1. ループ骨格

役割（v1 固定）:
- **claude = 提案者 / 改訂者。プランの所有権は常に claude 一人が持つ。**
- **codex = 批評者 / 検証者。codex は対案（修正プラン本体）を書かない。** 返すのは `COUNCIL_VERDICT`（判定行）と指摘のみ。

codex が具体的な修正方針を指摘に含めるのは可。ただしプランを書き換えるのは常に claude であり、収束シグナルは codex の verdict である。

（対称ディベート・役割スワップ・3体以上の参加は v2 以降）

```
R1  claude: topic                 → 提案v1
R1  codex : [topic + 提案v1]       → 批評 + 判定
R2  claude: [提案v1 + 批評]        → 提案v2
R2  codex : [提案v2 + 批評]        → 批評v2 + 判定
...  収束 or 上限まで
```

**コンテキスト制御（トークン肥大対策）:** 各ターンに渡すのは「直近の提案 + 直近の批評」のみ。全履歴は載せない。全文は council ログ + DB に残り、人間はそちらで追える。

## 2. 収束判定

codex の各批評ターンの末尾に、機械可読の判定を **1行必須** で吐かせる:

```
COUNCIL_VERDICT: {"verdict":"revise","severity":"major","open":2}
```

- `verdict`: `approve` | `revise`
- `severity`: `blocker` | `major` | `minor` | `nit`（残存する最重要の指摘レベル）
- `open`: 未解決の指摘件数

**収束バー:** `verdict=approve`、**または** blocker/major がゼロ。minor/nit のみ残存は収束扱い（nit による無限ラリーを止める）。

判定パースは `council-status` スクリプト側で **決定的に** 行う。LLM の自由判断に収束を委ねない。

## 3. ループ駆動

`council-run.sh` が全ループを **決定的に** 回す。既存の `ask.sh`（プランモードのクロス AI 問い合わせ）をラップする。

```
council-run.sh --topic "..." --max-rounds 4 --cost-limit <tokens>
  loop:
    ask.sh --ai claude --plan  → 提案
    ask.sh --ai codex  --plan  → 批評
    council-status（DB read → 判定パース + コスト合算）→ continue / stop
```

ラウンド計数・判定パース・コスト合算という **ガバナンス的にクリティカルな部分をコード側に置く**。オーケストレータ agent の役目は「起動して待つ → 結果を人間に提示」に縮小する。

**依存確認事項（実装第一歩の候補）:** `ask` がプロジェクトの defaultAi と無関係に AI を指定（`--ai claude` / `--ai codex`）できるか。できない場合は ask フローに `--ai` パラメータを追加するのが最初のタスク。

> **確認結果（2026-08-23 時点）:** `~/.claude/skills/devrelay-ask-member/scripts/ask.sh` を調査した結果、現状のオプションは `--project` / `--exec` / `--machine` / `--list` / `--question` のみで、**`--ai` オプションは未実装**であることを確認した。したがって v1 実装フェーズの最初のタスクは「`ask.sh`（および ask フロー全体）への `--ai` パラメータ追加」で確定する。

## 4. deliberationId と「真実は DB」の両立

「真実は Message テーブルにあり、manager はそれを read するだけ」という原則を守る。

**v1（スキーマ変更なし）:**
- deliberationId は kickoff 時にオーケストレータが採番: `del_YYYYMMDD_HHMMSS_<短乱数>`
- 各 Message 本文の先頭に構造化ヘッダを1行埋める: `COUNCIL_META: {"deliberationId":"...","round":2,"ai":"codex","verdict":"revise"}`
- council ログのファイル名にも deliberationId を埋める
- 「協議 X の全ターンを取得」はコンテンツスキャンになるが、協議は低頻度なので許容

**v2:** `Deliberation` テーブル + `Message.deliberationId` FK に昇格し、インデックス引きにする。採番権もサーバー側に寄せる（`BuildLog.buildNumber` のサーバー採番と同じ方針）。

## 5. コスト会計

新規インフラ不要。`usageData`（input/output tokens, model）が Message ごとに記録済み。協議ターンの usageData を DB から合算するだけ。Phase 1 の `GET /api/agent/messages` をそのまま使う。

コスト上限チェック = `sum(usageData across deliberation turns)` vs `--cost-limit`。

## 6. 打ち切り挙動

上限（max-rounds / cost-limit）に **未収束** で到達した場合、最後の提案を「収束ステータス付き」で人間に返す。

- `status`: `converged` | `max_rounds` | `cost_limit`
- 未収束時は、最後の批評ターンから **残論点（blocker/major のみ）** を抽出して添付する（追加 LLM コールなし）

人間の承認ゲートには「収束したか」「開いている論点は何か」が明示的に見える状態で乗る。

## 7. Council ログ

- 保存先: `doc/council/<project>/<timestamp>_<deliberationId>_<ai>.md`
- 1ターン = 1ファイル
- 内容: そのターンの入力（直近提案 + 直近批評）と出力（提案 or 批評 + 判定行）

## 8. 人間への最終成果物

協議完了時、以下を1つの「council 結果」として人間に提示する:
- deliberationId / 実行ラウンド数 / 合計コスト / 収束ステータス
- 最終提案（＝プラン本体）
- 残論点（未収束時のみ）
- 各ターンの council ログへの参照

**途中ラウンドの提示は行わない。** 協議を収束 or 打ち切りまで回し切ったあと、最終成果物のみを人間の承認ゲートに乗せる。
途中でのプラン提示・人間への割り込みをしないことが、協議を自動化する意義である（人間の確認回数を最終1回に絞る）。

→ 人間承認 → 通常の DevRelay exec（既存ゲート）へ。

## 9. v1 / v2 ライン

**v1 スコープ:**
- claude↔codex の2体・固定役割・逐次ラリー
- 構造化 verdict による収束判定（severity ベース）
- `council-run.sh`（決定的ループ、ask.sh ラップ）
- deliberationId はスキーマ変更なし（本文ヘッダ埋め込み）
- コストは usageData 合算の再利用
- 収束ステータス + 残論点付きで人間ゲートに提示
- 発火モデル = オプトイン（デフォルト OFF）
- `--council` オプションによる起動

**v2 以降（本 spec のスコープ外）:**
- `Deliberation` テーブル + `Message.deliberationId` FK、サーバー採番
- 差分サイズによる収束の二次判定
- 対称ディベート / 役割スワップ / 3体以上
- サーバーサイド オーケストレーション LLM
- UI トグルによるオプトイン

## 10. 発火モデル（オプトイン）

協議はデフォルト **OFF**。明示的にオプトインした時のみ発火する。

- **v1: コマンドオプション `--council`** で ON にする。ON のとき §3 の `council-run.sh` ループが起動する。
- **前提が揃わない場合の挙動:** 協議 ON でも対象マシンに利用可能な AI が2種未満の場合は、**静かに通常の単一 AI プラン/exec フローで返す**（協議されないだけ。エラー扱い・前提チェック失敗・人間への警告はしない）。
- **v2 布石:** 将来は UI トグル（会話ウィンドウ上の「協議」オプション）でのオプトインに対応する。

コマンド語彙は `council` で統一する（`--council` オプション / `doc/council/` ログ / `COUNCIL_VERDICT` / `COUNCIL_META` マーカーと揃える）。
