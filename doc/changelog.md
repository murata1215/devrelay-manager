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

## 2026-08-23

### 協議オーケストレーション (Council Orchestration) v1 仕様確定
- `doc/council-orchestration-spec.md` を新規作成（章0〜9: 位置づけ・ループ骨格・収束判定・ループ駆動・deliberationId・コスト会計・打ち切り挙動・council ログ・人間への最終成果物・v1/v2ライン）
- 追補1: §1 ループ骨格 — codex は対案（修正プラン本体）を書かない批評者、プラン所有権は常に claude、収束シグナルは codex の verdict と明確化
- 追補2: §8 人間への最終成果物 — 途中ラウンドの提示は行わず、最終成果物のみ人間承認ゲートに提示する方針を明記
- 追補3: §10「発火モデル（オプトイン）」を新設 — 協議はデフォルト OFF、`--council` オプションで ON。対象マシンの AI が2種未満の場合は静かに単一 AI フローへフォールバック（エラー扱いしない）
- §9 v1/v2 ラインを整合（オプトイン発火・`--council` を v1 スコープに追記、UI トグルを v2 に追記）
- 事前調査で `ask.sh` に `--ai` オプションが未実装と判明 → v1 実装の第一タスクとして spec 内に記録

### devlog 運用を開始
- `doc/devlog/` を新規作成（1サイクル＝1ファイルの開発記録）
- `doc/devlog/2026-08-23_133347.md`（サイクル1.0: 協議オーケストレーション v1 仕様確定）を作成
- `doc/devlog/INDEX.md` を新規作成し、サイクル一覧の索引運用を開始
