# 商品名自動修正侍（Product Name Auto-Correction Samurai）

## プロジェクト概要

楽天市場の商品名を、プロモーションイベント（お買い物マラソン、5の日、0の日、いちばの日、ワンダフルデーなど）に合わせて自動で書き換えるツール。イベント開始時に商品名の先頭にプレフィックスを付与し、終了時に除去する。マルチテナント対応で、複数の楽天ショップ運営者が利用可能。

## アーキテクチャ

```
┌───────────────────┐       HTTPS        ┌───────────────────┐        ┌─────────────────────┐
│  GitHub Pages     │  ←──────────────→  │  Google Apps      │  ←──→  │  Google Sheets      │
│  (フロントエンド)   │    JSON API        │  Script (API)     │        │  (データ管理)         │
│  index.html       │                    │  WebApi.gs        │        │                     │
│  js/app.js        │                    │  他 .gs ファイル    │        │  認証用SS + メインSS  │
│  css/style.css    │                    │                   │  ←──→  │                     │
└───────────────────┘                    │                   │        └─────────────────────┘
                                         │                   │
                                         │                   │  ←──→  楽天 RMS ItemAPI 2.0
                                         └───────────────────┘        Slack / Email 通知
```

## ディレクトリ構成

```
itemname/
├── CLAUDE.md           # このファイル
├── index.html          # フロントエンド HTML（GitHub Pages で公開）
├── css/
│   └── style.css       # 楽天カラー（赤）ベースのスタイル
├── js/
│   └── app.js          # フロントエンドロジック（API通信・UI制御）
├── CNAME               # カスタムドメイン設定
├── design.dat          # デザインデータ
└── gas/                # GASコード（clasp で管理） ※ 要セットアップ
    ├── .clasp.json
    ├── appsscript.json
    ├── Config.gs       # 定数・設定
    ├── SheetRepo.gs    # スプレッドシート操作（マルチテナント対応）
    ├── WebApi.gs       # doGet/doPost ルーター・認証
    ├── Auth.gs         # 認証・セッション管理
    ├── ItemManager.gs  # 商品名書き換えロジック
    ├── EventManager.gs # イベント判定・自動生成
    ├── RakutenApi.gs   # 楽天API呼び出し
    ├── Main.gs         # メイン処理・トリガー
    └── Trigger.gs      # トリガー管理（月次イベント生成）
```

## 技術スタック

- **フロントエンド**: HTML / CSS / Vanilla JS（GitHub Pages ホスティング）
- **バックエンド**: Google Apps Script (GAS)
- **データ**: Google Sheets（2つのスプレッドシートを使用）
- **外部API**: 楽天 RMS ItemAPI 2.0
- **通知**: Slack / Email
- **デプロイ**: GitHub Pages（フロント）、GAS Web App（バックエンド）
- **GAS管理**: clasp（ローカル編集 → `clasp push` でGASに反映）

## スプレッドシート構成

### 認証用スプレッドシート（AUTH_SPREADSHEET_ID）
- `api_key` シート: ユーザー認証情報
  - カラム: id, CHATGPT_API_KEY, licenseKey, serviceSecret, download, pw, sid, sname, email, flag, expiry
  - pw は `BASE64:xxxxx` 形式で保存
  - sid = 楽天店舗ID（例: 240364）

### メインスプレッドシート（SPREADSHEET_ID）
- `EVENTS` シート（共通）: イベントスケジュール
  - eventKey, startDatetime, endDatetime, priority, prefixLong, prefixMid, prefixShort, enabled
- 店舗別シート（マルチテナント、命名規則: `{prefix}_{sid}`）:
  - `S_{sid}` : 設定（例: S_240364）
  - `T_{sid}` : 対象商品（例: T_240364）
  - `L_{sid}` : ログ（例: L_240364）
  - `B_{sid}` : バックアップ（例: B_240364）

## 主要機能

### UI タブ構成（フロントエンド）
1. **⚙️ 設定** - 実行モード、DryRun、最大処理件数、通知設定
2. **📦 対象商品** - 一覧表示、追加（楽天APIから商品名自動取得）、削除
3. **📅 イベント** - 共通イベント＋店舗カスタムイベントのスケジュール管理
4. **📋 ログ** - 実行履歴（新しい順で表示）
5. **▶️ 手動実行** - DryRun / 本番実行

### 商品名処理フロー
1. EVENTSシートでイベント期間を判定
2. 対象商品リストを取得
3. ベース商品名にイベントプレフィックスを付与（楽天の全角127文字制限内でスマート短縮）
4. 楽天 RMS ItemAPI 2.0 で商品名を PATCH 更新
5. ログ記録・通知送信

### 安全機能
- **DryRunモード**: 実際の更新を行わずログのみ記録
- **手動変更検知**: ユーザーが手動変更した商品名は上書きしない（類似度80%判定）
- **バックアップ/復元**: 元の商品名を保持
- **排他制御**: LockService による同時実行防止
- **APIリトライ**: 最大3回、2秒間隔

## 開発ワークフロー

### フロントエンド変更時
```bash
# 編集後
git add .
git commit -m "fix: ○○修正"
git push
# → GitHub Pages に自動反映
```

### GASコード変更時
```bash
cd gas
# ファイルを編集
clasp push
# → GASプロジェクトに反映
# 必要に応じて GAS Web App を再デプロイ
```

### GASコードの最新を取得
```bash
cd gas
clasp pull
```

## 注意事項

- GASの実行時間制限は6分。大量商品処理時に注意
- `clasp push` 後、APIエンドポイントの変更がある場合は GAS 側で「新しいデプロイ」が必要
- フロントの `js/app.js` 冒頭の `API_URL` がGASデプロイURLと一致していること

### ⚠️ デプロイ（`clasp deploy`/`clasp redeploy`）は必ずオーナーアカウントで実行すること

`gas/appsscript.json` の `webapp.executeAs` は **`USER_DEPLOYING`**。account/gas（コンテンツページ生成ちゃん）で2026-08-18に発生したインシデント（デプロイ実行アカウントがオーナー以外だと本番exec URLがHTTP 403を返すようになる）と同じ設定・同じリスクがこのプロジェクトにも当てはまる。

- `clasp push`（HEAD更新のみ）は編集者権限があれば誰が実行しても安全
- `clasp deploy`/`clasp redeploy`（本番デプロイの更新）は**必ずオーナーアカウント（tokyoflowerco.ltd）で実行する**。Claude Code等が`clasp push`でHEADを更新した後、実際のデプロイはGASエディタで人間（tokyoflowerco.ltd）が行うこと
- 詳細・インシデント実例: `X:\git\account\gas\CLAUDE.md` 「⚠️ デプロイは必ずオーナーアカウントで実行すること」、`X:\projects\_inventory\account-registry.md`
- スプレッドシートIDは Config.gs 内で管理（直接変更しない）
- パスワード照合時: 入力値をBASE64エンコードしてシートの値と比較
- イベント自動生成は毎月26日 9:00 にトリガー実行

## テスト用店舗

- 店舗名: 花とギフト銀座東京フラワー
- sid: 240364
- ログインID: tokyoflower
