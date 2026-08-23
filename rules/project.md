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

## 協議オーケストレーション (Council Orchestration)

- claude↔codex の逐次協議機構。仕様は `doc/council-orchestration-spec.md` を参照
- v1 は claude=提案者/プラン所有者、codex=批評者（対案は書かない）の固定役割
- 協議はデフォルト OFF のオプトイン。`--council` オプションで明示的に ON にした場合のみ発火
- 対象マシンに利用可能な AI が2種未満なら、協議 ON でも静かに通常の単一 AI フローへフォールバックする（エラー扱いしない）
- 人間への提示は収束/打ち切りまで回し切った後の最終成果物1回のみ（途中ラウンドは提示しない）

## devlog（開発記録）運用

- 開発サイクルごとの記録を `doc/devlog/<TZ=Asia/Tokyo timestamp>.md`（1サイクル=1ファイル）で残す
- 索引は `doc/devlog/INDEX.md` に1行ずつ追記
- 本文フォーマット: 見出し1行 + `要求` / `実行` / `検証` / `発見` の4ブロック
