# Changelog

## 2026-06-20

### DevRelay Agreement v6 適用
- `rules/devrelay.md` を新規作成（DevRelay 共通ルール全文）
- `CLAUDE.md` を更新（v6 マーカー + ルールファイル参照）
- 補助ファイル作成: `doc/changelog.md`, `doc/issues.md`, `rules/project.md`

### mviewer: フォルダ履歴機能を実装委譲
- mviewer（Lepafy）プロジェクトに teamexec でフォルダ履歴機能の実装を委譲
- 「📂 開く」ボタン横に「▼」ドロップダウンで過去のフォルダを選択可能に
- 履歴は `%APPDATA%/lepafy/history.json` に最大20件保存
- 変更ファイル: main.js, preload.js, renderer.js, index.html, styles.css
