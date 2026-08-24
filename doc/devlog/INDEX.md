# Devlog INDEX

- 2026-08-23_133347 | サイクル1.0 | 協議オーケストレーション v1 仕様確定 | claude↔codex 協議の設計を確定し spec を devrelay-manager に着地
- 2026-08-23_191839 | サイクル1.1 | council-run.sh 骨格実装 | codex非依存スコープでループ本体・verdictパーサ・コスト合算を実装、fixtureベース55件検証
- 2026-08-24_062833 | サイクル1.2 | web-manager-surface 構想doc追加 | web.devrelay.io（manager会話サーフェス）のv1構想スペックを人間レビュー済み確定内容として devrelay-manager doc/ に verbatim 着地
- 2026-08-24_100739 | サイクル1.3 | manager サービス骨格立ち上げ | pnpm モノレポ + Fastify + Prisma/PostgreSQL で Thread/Message/Dispatch を実装、health/thread/message API を実測疎通確認、既存 bash 資産55件は非破壊
- 2026-08-24_132111 | サイクル1.4 | manager→core 接続アダプタ | core の MCP を localhost+PAT で再利用する型付きアダプタを実装、実core相手のスモークで89 projects取得を実測確認、既存API・bash資産55件は非破壊
- 2026-08-24_225755 | サイクル1.5 | orchestrator(層③) 設計doc追加 | Dispatchステートマシン・2承認ゲート・staleCheck等を含む層③設計スペックを人間レビュー済み確定内容として devrelay-manager doc/ に verbatim 着地
- 2026-08-24_233847 | サイクル1.7 ③-1 | Dispatch 状態機械 + DB | 10状態遷移表を dispatch-state.ts に一元化し楽観ロック付き永続化層 dispatch-store.ts を実装、22件のユニットテスト全pass・既存bash55件非破壊を実測確認
- 2026-08-25_064759 | サイクル1.8 ③-2 | 決定的 worker（ポーリング駆動） | LLM不使用のtick/reconcileOrphans/人間承認ゲート4関数を実装、常駐形態を単一プロセスsetTimeoutループ+行CASの二重処理防止に決定、テスト48件追加（計70件）全pass・既存bash55件非破壊を実測確認
- 2026-08-25_075556 | サイクル1.9 ③-2 | 実機スモーク（worker on） | 実coreに対しdraft→submitting→planning→ゲート1→awaiting_approval→ゲート2→approving→buildingを実測、両ゲートの自動通過ゼロ・バックオフ階段2→3→5分キャップ・kill×2回のDB内容のみ復帰・CASによる二重処理防止を確認、coreは第二プロセスを立てず本セッション自身のplanファイルへ指示を注入する第4の直列化パターンを発見しコード無変更のまま記録
- 2026-08-25_075519 | サイクル1.9 ③-2 | 実機スモーク（worker on） | コード変更ゼロで実core・実DB相手にdraft→submitting→planning→ゲート1→approving→buildingを実測駆動、両ゲートの自動通過ゼロ・バックオフ階段(30秒→2分9秒→3分→5分キャップ)・kill/再起動のDB内完結復帰・CAS二重処理防止を実測確認、対象projectが自分自身の稼働リポジトリでcoreが第二プロセスでなく自セッションのplanファイルへ自己ループする重大挙動を発見・回避せず記録
