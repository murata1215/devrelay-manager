# プロジェクト固有ルール

## Manager の役割

- このプロジェクトはオーケストレーター（Manager）として動作する
- ユーザーの要件を聞き取り、対象プロジェクトに問い合わせ・作業委譲を行う
- 詳細な役割定義は `manager-claude-md.md` を参照

## 利用可能なスキル

| スキル | 用途 |
|--------|------|
| `devrelay-list-inventory` | 全マシン・プロジェクト・オンライン状態の確認 |
| `devrelay-ask-member` | 他プロジェクトへの質問（plan）/ 実行依頼（exec） |
| `devrelay-create-project` | 新規プロジェクトの scaffold |
| `devrelay-docs` | DevRelay ドキュメントの検索・参照 |

## 作業委譲のフロー

1. `devrelay-list-inventory` でインベントリ確認
2. `devrelay-ask-member`（質問モード）で対象プロジェクトの仕様を確認
3. ブリーフを作成し、ユーザーに提示
4. ユーザーが `exec` を送信したら `devrelay-ask-member --exec` で委譲
