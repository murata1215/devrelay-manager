# Devlog INDEX

- 2026-08-23_133347 | サイクル1.0 | 協議オーケストレーション v1 仕様確定 | claude↔codex 協議の設計を確定し spec を devrelay-manager に着地
- 2026-08-23_191839 | サイクル1.1 | council-run.sh 骨格実装 | codex非依存スコープでループ本体・verdictパーサ・コスト合算を実装、fixtureベース55件検証
- 2026-08-24_062833 | サイクル1.2 | web-manager-surface 構想doc追加 | web.devrelay.io（manager会話サーフェス）のv1構想スペックを人間レビュー済み確定内容として devrelay-manager doc/ に verbatim 着地
- 2026-08-24_100739 | サイクル1.3 | manager サービス骨格立ち上げ | pnpm モノレポ + Fastify + Prisma/PostgreSQL で Thread/Message/Dispatch を実装、health/thread/message API を実測疎通確認、既存 bash 資産55件は非破壊
- 2026-08-24_132111 | サイクル1.4 | manager→core 接続アダプタ | core の MCP を localhost+PAT で再利用する型付きアダプタを実装、実core相手のスモークで89 projects取得を実測確認、既存API・bash資産55件は非破壊
