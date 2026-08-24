# 層③ orchestrator 設計スペック

> 状態: **v1 設計確定**。devrelay-manager `doc/` に着地（commit 済み）。
> 関連: `doc/web-manager-surface-concept.md`（§6 council トグル／§8 backend）、`doc/council-orchestration-spec.md`
> 前提: 層①（DB＋サービス骨格）・層②（core MCP アダプタ、実疎通済み）完了。

---

## 0. ③の正体

**「今 MCP 越しに人間＋Claude が手でやっている submit→plan→承認→build」を、DB 裏付きでホスト化したもの。**

決定的な設計原則（ここを外すと全部間違える）:

> **③は「回りっぱなしのループ」ではなく、DB を状態に持つ “再開可能なステートマシン”。イベントが来るたびに1ターンだけ動いて yield する。**

理由：**承認は人間の時間（数分〜数時間〜数日）を跨ぐ**。`approve_implementation` の手前で人間のタップ待ちで止まる必要がある。メモリ上のループを何時間も抱えるのは不可能。よって orchestrator は「ユーザー発話 / 承認タップ / ポーラーの tick」という**イベント駆動**で、都度 DB からスレ状態を読み、次の一手を決め、DB を更新して終わる。これは過剰設計ではなく、承認が人間時間を跨ぐ以上の**最小の正しい形**。

---

## 1. 役割分担（council と同じ哲学）

- **LLM が担うのは「内容・判断」だけ**：発話を dispatch すべきか会話で返すか／repo 推定（提案）／instruction 本文の作文／build 結果の要約。
- **決定的コードが担うのは「状態遷移・ポーリング」**：`submit→plan→approve→build` の進行、ポーリング間隔、Dispatch の status 遷移、テンプレ注入、stale 検証。
- council-run.sh で「ループは決定的・verdict 判断だけ AI」にしたのと同型。ここが破れると premature done 系のバグが戻る。

---

## 2. Dispatch ステートマシン（心臓部）

```
draft            ← orchestrator LLM が {repo + instruction + 選定理由} を作文
  │  [人間: この宛先・内容で投げる？]   ← 承認ゲート①（無期限保留・督促通知）
  │      └─ submit 直前に freshCheck（対象 repo の存在・online 再確認）
  ▼
submitting → planning        ← coreClient.submitInstruction、submissionId 保存
  │  (ポーラーが getPlan を 2/3/4分…上限5分/最大30分でポーリング)
  ▼
awaiting_approval            ← plan 到着、承認カード表示（無期限保留・督促通知）
  │  [人間: この plan で exec？]        ← 承認ゲート②
  │      └─ 承認アクション時に staleCheck（core 再照会：submission 生存 / HEAD ズレ）
  │             └─ 古い → stale（「取り直す？」導線。stopped にはしない）→ 再 getPlan
  ▼
approving → building         ← coreClient.approveImplementation、buildId 保存
  │  (ポーラーが getBuildStatus をポーリング)
  ▼
done / failed / stopped      ← done:要約＋devlogリンク / stopped:STOP を人間へ
```

- 各状態は①(DB) `Dispatch.status` に対応。遷移のたびに DB 更新＝クラッシュしても再開可能。
- **status 値**: `draft` / `submitting` / `planning` / `awaiting_approval` / `stale` / `approving` / `building` / `done` / `failed` / `stopped`。
  - ①では `pending/planning/awaiting_approval/building/done/failed/stopped` を列挙済み。③で `draft/submitting/stale/approving` を追加（String なので値追加のみ、スキーマ変更不要）。

---

## 3. 承認ゲートは2つ【確定 D1】

- **ゲート①（宛先・内容）**：orchestrator が「どの repo に・何を」提案 → 人間が承認。**submit 前に repo 誤爆を止める**（§7 の誤爆懸念への直接の答え）。submit 直前に freshCheck（repo 存在・online）。
- **ゲート②（core plan）**：core から plan が返ったら承認カード → 人間が exec 承認。**承認アクション時に staleCheck**（§8）。
- 手動 MCP フロー（submit前確認＋plan承認）と同型。confidence 高い時のゲート①自動化は v2。

---

## 4. バックグラウンド worker / ポーラー（LLM 不使用）

- `planning` / `building` を前進させるのは **決定的な worker**（LLM を呼ばない）。`getPlan` / `getBuildStatus` を間隔ポーリングし、状態が変わったら DB 更新＋フロントへ push（PWA + FCM）。
- ポーリング間隔は preference 準拠（2→3→4…上限5分・最大30分）を決定的コードに固定。
- worker は「起動中スレを DB から拾って進める」常駐プロセス（v1 は単一プロセスで可。pm2 化は後）。

---

## 5. governance テンプレは manager が決定的に注入【確定 D2】

- 「AskUserQuestion禁止 / devlog ルール / スコープ厳守 / STOP 哲学 / 実行ユーザー」等の**保証をLLMの記憶に頼らない**。忘れた瞬間に崩れる。
- **manager が instruction を機械的に包む**：LLM は「やりたいこと」だけ作文 → manager が定型の前後文（規約・devlog指示・STOP条件）を決定的に付与して submit。
- council の決定性と同じ。テンプレは Settings で管理。

---

## 6. orchestrator モデル選択 = 入力枠【確定 D3】

- **入力枠にモデルセレクタ**（ChatGPT のモデル切替の位置）。web サーフェスでは **[モデルセレクタ]＋[council トグル]** が入力欄脇に並ぶ。
- これが選ぶのは **orchestrator モデル（manager の頭脳）**。**executor AI（core の `--ai`＝claude/codex）とは別軸**（後者は council トグル／dispatch 側）。混同しない。
- **memory の三層構想と合流**：セレクタは tier（Heavy / Standard / Light）を選び、**tier→model の束ねは manager Settings JSON**（route-resolver v1 の「手動 tier→model バインド」を再利用）。
  - 例（実装時に現行モデル・価格を確認して確定）：Heavy=Opus / Standard=Sonnet / Light=Haiku。
- **既定**：Standard。スレッド既定を持ち、**メッセージ単位で上書き可**（per-message）。選択値は Dispatch と Message に記録（監査・コスト按分のため）。

---

## 7. repo 推定（提案）ロジック【確定 §10-2】

- **手掛かりの合わせ技**で候補を出す：`list_projects`（`online` 含む）＋ プロジェクト名/別名マッチ ＋ 直近スレ文脈。
- **確信度が低ければ候補を複数出して人間に選ばせる**（単一に決め打たない）。ゲート①のカードに候補が並ぶ。
- 常に「提案」。決めるのは人間（§9）。

---

## 8. 承認待ち = 無期限保留 ＋ stale 検証【確定 §10-1】

「腐った plan をうっかり承認」を防ぐのが主眼。タイムアウトで殺すのではなく、**承認時点で鮮度を検証**する。

- **タイムアウトで `stopped` にはしない**。gate は無期限で残す（督促通知は出す）。governance 的に「勝手に諦めない」を守る。
- **ゲート②の承認アクション時に staleCheck**：core へ再照会し、submission が生存しているか／plan 作成時点の HEAD からズレていないかを確認。
  - 古ければ承認を止め、`stale` にして「plan が古い。取り直す？」を提示（`stopped` ではなく**再取得導線**）→ 再 `getPlan`。
- **ゲート①の submit アクション時に freshCheck**：対象 repo の存在・online を再確認。
- 実装コストは小：承認/submit ハンドラに再照会を1回挟むだけ。

---

## 9. v1 スコープ【確定 D4】

- **発話は常に「提案」**。勝手に実行しない。
- **純粋な会話・質問は会話で返すだけ**（Dispatch を作らない）＝分類ミスの安全網。orchestrator の最初の判断は「これは dispatch か / 会話か」。
- **1 dispatch = 1 repo**（横断ファンアウトは v1.5）。
- **コスト集計は最小 or 後回し**（core build のコスト取得経路が未確定なため。§12）。

---

## 10. STOP は握り潰さず `stopped`【no-silent-failure】

- core からの STOP（.env 不備・PAT 401・到達不可 等）や orchestrator 自身の中断条件は、**フォールバックせず `stopped` にして人間へ理由を提示**。
- §8 の `stale`（古い plan）とは区別：`stopped`=異常/中断、`stale`=正常だが要再取得。

---

## 11. web サーフェス doc への波及

`doc/web-manager-surface-concept.md` に反映が要る点（③確定後に追記）:
- §6：入力欄脇のコントロールは **council トグル＋モデルセレクタの2つ**。
- §3 レイアウト図：入力欄に model selector を追記。
- 承認カードは**2ゲート**（宛先確認カード → plan 承認カード）＋ stale 時の「取り直し」導線。

---

## 12. 未解決 / 要決定

- [x] **§10-1 承認待ち**：無期限保留 ＋ 承認時 staleCheck（`stale` 状態追加）
- [x] **§10-2 repo 推定**：list_projects(online)＋名前/別名マッチ＋文脈、低確信は複数候補
- [x] **D1〜D4**：2ゲート / テンプレ注入 / 入力枠モデル選択 / v1スコープ
- [ ] tier セット・既定・tier↔model 初期バインド（§6、実装時に現行モデルで確定）
- [ ] コスト取得経路（core build のコストをどう取るか。ライブ結線は council と同じく後続）
- [x] **worker の常駐方式の詳細**（サイクル1.8 ③-2 で決定）: manager プロセス内の
  常駐ループ（`setTimeout` 再帰＋`unref()`）＋ `DISPATCH_WORKER_MODE`
  (`off`|`manual`|`resident`、既定 `off`) による切替。却下案: 外部 cron/systemd
  timer（プロセス起動・接続管理の二重化、spec本文の「単一プロセスで可」に反する）、
  Postgres advisory lock によるリーダー選出（Prisma のコネクションプール越しに
  セッションがリークする上、行レベル CAS があれば多重起動しても安全なため不要）、
  BullMQ 等のジョブキュー（Redis という新規インフラ依存を持ち込む）。詳細・実装は
  `apps/server/src/orchestrator/dispatch-worker.ts` および devlog
  `doc/devlog/2026-08-25_*.md`（サイクル1.8 ③-2）参照。
- [ ] **（新規）building のポーリングバジェット**: サイクル1.8 ③-2 の実装では
  本文§4の30分（planning想定）をそのまま building に適用せず120分にした（実ビルド
  所要時間が未実測のため暫定値）。実測値が得られ次第、正式な値に更新すること。

---

## 13. 明示的に「やらないこと」（v1 非スコープ）

- 承認なしの自動実行（ゲート①自動化は v2）。
- 横断ファンアウト（1発話→複数 repo、v1.5）。
- council 実結線（⑤・codex 必要＝8/25+）。ただし**モデルセレクタと council トグルの UI 枠は③で用意**しておく。
- 過剰なコスト按分・課金（v1 は記録のみ、按分は後）。
