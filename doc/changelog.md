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

### mviewer: ビルド実行
- teamexec で mviewer のビルドを委譲（electron-builder）
- 成果物: `Lepafy Setup 1.1.0.exe`（97MB, NSIS インストーラー）, `Lepafy 1.1.0.exe`（97MB, ポータブル版）
- ターゲット: Windows x64 / Electron 42.2.0

## 2026-06-21

### mviewer: ドライブ使用率インジケータを実装委譲
- ツールバーに現在開いているフォルダのドライブ使用率を表示
- 表示: 💾 D: 1.4TB / 1.9TB (75%) + ミニプログレスバー
- 色分け: 緑(<70%) / 黄(70-90%) / 赤(>90%)
- `fs.promises.statfs` 使用（追加依存なし）
- バー表示修正: display:block追加、背景/ボーダー改善

### mviewer: ビルド & wrap up
- クリーンビルド実行 → Lepafy 1.1.0（インストーラー + ポータブル版）
- wrap up 委譲 → コミット b63792c、origin/main プッシュ済み
