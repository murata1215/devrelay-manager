# DevRelay Manager

DevRelay のオーケストレーター（Manager）プロジェクト。

ユーザーの全マシン・全プロジェクトをスコープに持ち、要件の聞き取り → 調査 → ブリーフ作成 → 実装委譲のフローを実行します。

## 機能

- **インベントリ確認** — 全マシン・プロジェクト・オンライン状態を一覧表示
- **クロスプロジェクト問い合わせ** — 他プロジェクトの仕様や状態を質問
- **ビルド委譲** — 対象プロジェクトに実装作業を委譲（teamexec）
- **新規プロジェクト作成** — 対象マシンに scaffold を作成
- **協議オーケストレーション (Council)** — claude↔codex の逐次協議によりプランを強化してから人間承認ゲートに乗せる（v1 仕様: `doc/council-orchestration-spec.md`、デフォルト OFF・`--council` オプトイン）

## ディレクトリ構成

```
devrelay-manager/
  CLAUDE.md              # Claude Code 設定（簡潔に）
  manager-claude-md.md   # Manager の役割定義（詳細）
  rules/
    devrelay.md          # DevRelay 共通ルール
    project.md           # プロジェクト固有ルール
  doc/
    changelog.md         # 変更履歴
    issues.md            # 課題管理
    council-orchestration-spec.md  # 協議オーケストレーション v1 仕様
    devlog/               # 開発サイクルごとの記録（1サイクル=1ファイル）
      INDEX.md             # devlog 索引
  scripts/
    council-run.sh        # Council ループ駆動スクリプト（ask.sh をラップ）
    lib/council-lib.sh    # Council 用の純粋関数群（verdictパーサ・収束判定等）
  tests/
    run-tests.sh           # 外部依存なしのテストランナー
    mock-ask.sh             # ask.sh 互換モック（ネットワーク未使用）
    fixtures/               # verdict・提案・usageサンプル
```

## Council（協議オーケストレーション）の使い方

```
bash scripts/council-run.sh --project <名前> --topic "<議題>" --council
```

`--council` を付けない場合は通常の単一 AI 問い合わせ（`ask.sh` 1回呼び出し）と同じ挙動です（後方互換）。テストは `bash tests/run-tests.sh` で実行できます。

## 使い方

DevRelay 経由で Manager に要件を伝えると、以下のフローで作業を進めます：

1. **Plan モード** — 要件を聞き取り、インベントリ確認・問い合わせを行い、ブリーフを作成
2. **Exec モード** — ユーザーが `e` を送信後、対象プロジェクトに実装を委譲
