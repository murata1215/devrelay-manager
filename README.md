# DevRelay Manager

DevRelay のオーケストレーター（Manager）プロジェクト。

ユーザーの全マシン・全プロジェクトをスコープに持ち、要件の聞き取り → 調査 → ブリーフ作成 → 実装委譲のフローを実行します。

## 機能

- **インベントリ確認** — 全マシン・プロジェクト・オンライン状態を一覧表示
- **クロスプロジェクト問い合わせ** — 他プロジェクトの仕様や状態を質問
- **ビルド委譲** — 対象プロジェクトに実装作業を委譲（teamexec）
- **新規プロジェクト作成** — 対象マシンに scaffold を作成

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
```

## 使い方

DevRelay 経由で Manager に要件を伝えると、以下のフローで作業を進めます：

1. **Plan モード** — 要件を聞き取り、インベントリ確認・問い合わせを行い、ブリーフを作成
2. **Exec モード** — ユーザーが `e` を送信後、対象プロジェクトに実装を委譲
