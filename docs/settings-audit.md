# 設定タブ 監査メモ（settings-audit）

- 調査日: 2026-11-18
- 対象ブランチ: `feature/settings-simplify`（基点: `main` @ 6e33f87）
- 対象: 管理画面「⚙️ 設定」タブ（`index.html` / `js/app.js`）と、その保存先である `S_{sid}` シート（`gas/` は調査のみ・変更なし）

## 1. 保存の仕組み（前提）

- `S_{sid}` シートは `key` / `value` の2列。1設定＝1行（「列名」ではなく `key` 列の値がキー名）。
- 読込: `gas/SheetRepo.js` `loadSettings(sid)` … `DEFAULT_SETTINGS`（`gas/Constants.js`）にシートの値を上書きして返す。
- 保存: フロント `saveSettings()` → API `updateSettings` → `gas/WebApi.js` `handleUpdateSettings_`（`allowedKeys` で絞り込み）→ `SheetRepo.js` `saveSettings()`。
  - **シートに既に行があるキーだけ**が更新される（行の新規追加はしない）。
  - 送信しなかったキーはシート上の値がそのまま残る。
- ロール: `api_key` シートの `role` 列（無ければ `userId === 'tokyoflower'` のみ `admin`）。フロントは `.admin-only` クラス＋`applyRoleVisibility()` で表示制御。

## 2. 設定タブの項目（UIがあるもの・全5件）

| 項目名 | DOM id | 保存キー（S_{sid}） | 既定値 | 利用頻度の見込み | 参照ロジック | 分類 | 対応 |
|---|---|---|---|---|---|---|---|
| 実行モード | `settingMode` | `mode` | `TARGET_LIST` | 低（導入時に1回決めれば変えない） | `gas/Main.js` `fetchTargetItems`（`ALL_ACTIVE` なら販売中の全商品を取得） | 既定値で十分 | 「詳細設定」へ折りたたみ（全ユーザー表示） |
| DryRunモード | `settingDryRun` | `dryRun` | `true` | 低（本番切替時に1回） | `gas/Main.js` `runForStore` / `processItems`（`false` のとき定期実行が実際に商品名を更新） | 上級者・開発者向け | 「詳細設定」内の管理者専用ブロックへ移動（admin のみ表示） |
| Slack通知 | `settingNotifySlack` | `notifySlack` | `false` | なし（機能しない） | `gas/Main.js` `sendNotification` | 未実装・機能しない | 非表示（TODOコメント） |
| メール通知 | `settingNotifyEmail` | `notifyEmail` | `false` | なし（機能しない） | `gas/Main.js` `sendNotification` | 未実装・機能しない | 非表示（TODOコメント） |
| 1回の最大処理件数 | `settingMaxItems` | `maxItemsPerRun` | `500` | 低（`ALL_ACTIVE` 時のみ有効） | `gas/Main.js` `fetchTargetItems` → `getAllItems` | 上級者・開発者向け（従来から admin 専用） | 「詳細設定」内の管理者専用ブロック（変更なし） |

「残す（日常運用で必須）」に該当する編集項目は **0件**。日常運用（対象商品の追加・イベント確認・ログ確認）はいずれも設定を変更せずに行える。
そのため設定タブの通常表示は「現在の動作」（処理対象／自動実行の状態・表示のみ）だけとし、編集項目はすべて「詳細設定」に入れた。

## 3. UIが無い設定キー（参考・今回変更なし）

`handleUpdateSettings_` の `allowedKeys` には含まれるが、画面に入力欄が無いもの。

| 保存キー | 既定値（`DEFAULT_SETTINGS`） | 参照箇所 | 備考 |
|---|---|---|---|
| `maxTitleZenkaku` | `127` | `Main.js`（商品名の文字数上限） | シート直接編集のみ |
| `keepNonEventBrackets` | `true` | `Main.js` / `TitleLogic.js` | シート直接編集のみ |
| `shopMultiplierEnabled` | `false` | `TitleLogic.js` | シート直接編集のみ |
| `shopMultiplierRate` | `2` | `TitleLogic.js` | シート直接編集のみ |
| `batchSize` | `20` | **参照なし** | 未使用。削除候補 |
| `apiSleepMs` | `1000` | `Main.js` | シート直接編集のみ |
| `logRetentionDays` | `90` | `Main.js`（古いログ削除） | シート直接編集のみ |
| `slackWebhookUrl` | **定義なし** | `Main.js` `sendNotification` | 下記 4-1 参照 |
| `notifyEmailAddress` | **定義なし** | `Main.js` `sendNotification` | 下記 4-1 参照 |

## 4. 見つかった不整合

### 4-1. 通知設定は ON にしても送信されない（未実装扱いの根拠）

- `sendNotification` は `notifySlack && slackWebhookUrl`、`notifyEmail && notifyEmailAddress` の両方が揃ったときだけ送信する。
- しかし `slackWebhookUrl` / `notifyEmailAddress` は
  - `index.html` に入力欄が無い
  - `Constants.js` の `DEFAULT_SETTINGS` に無い → `S_{sid}` シート作成時に行が作られない
  - `SheetRepo.js` `saveSettings` は既存行しか更新しない → API 経由でも保存できない
- つまり、シートに手で行を追加しない限り、チェックボックスを ON にしても通知は飛ばない。
- 対応: チェックボックスを非表示（`settings-unimplemented`）。保存処理は従来どおり `notifySlack` / `notifyEmail` を送信する（読み込んだ値をそのまま送り返すので値は変わらない）。

### 4-2. DryRun が「管理者専用」とコメントされつつ全ユーザーに表示されていた

- `js/app.js` のコメントは「管理者専用設定（非表示でもフォーム値はセット）」だが、`index.html` 上は共通ブロックにあり一般ユーザーも変更できた。
- 対応: 管理者専用ブロック（`#adminSettings`）へ移動。あわせて一般ユーザーの保存時は `dryRun` を送信しないようにした（`maxItemsPerRun` と同じ既存パターン）。
  非表示の項目を初期値のまま送ってしまい、意図せず値が書き換わるのを防ぐため。

### 4-3. サーバー側（GAS）にロールチェックが無い【今回は未対応・要検討】

- `handleUpdateSettings_` は認証のみで、ロールを見ていない。一般ユーザーでも API を直接呼べば `dryRun` / `maxItemsPerRun` を変更できる。
- 今回の admin 限定は**画面表示上の制御のみ**。厳密に制限するなら GAS 側の対応が必要（本タスクは GAS 変更なしの方針のため未実施）。

### 4-4. その他（コメントと実装のずれ）

- `gas/WebApi.js` `handleRunManual_` のコメントは「DryRunのみ許可」だが、実際は admin なら本番実行も可能。
- `index.html` フッター・ログイン画面の年表記が 2024 のまま（設定とは無関係・未変更）。

## 5. 分類まとめ

| 分類 | 項目 |
|---|---|
| 残す（通常表示） | 編集項目なし。「現在の動作」の表示のみ（処理対象／自動実行の状態） |
| 詳細設定へ（全ユーザー） | 実行モード（`mode`） |
| 詳細設定へ（admin のみ） | DryRunモード（`dryRun`）、1回の最大処理件数（`maxItemsPerRun`） |
| 非表示（未実装） | Slack通知（`notifySlack`）、メール通知（`notifyEmail`） |
| 削除候補（今回は削除していない） | `batchSize`（未参照）。通知4キーは「実装する／やめる」の判断待ち |

## 6. 既定値の見直し

- フロントのフォールバック値（`mode` → `TARGET_LIST`、`maxItemsPerRun` → `500`）は `DEFAULT_SETTINGS` と一致しており変更不要。
- 設定の既定値（`TARGET_LIST` / `dryRun: true`）のままで対象商品追加・イベント確認・DryRun 実行ができるため、設定値の既定は変更していない。
- 変更したのは**ログイン直後に開くタブ**のみ: 「⚙️ 設定」→「📦 対象商品」。設定タブはタブ列の末尾へ移動。

## 7. 運用上の注意（要確認）

- DryRun の切替が admin のみになったため、**一般ユーザーは自分で本番稼働（DryRun OFF）へ切り替えられなくなる**。
  新規店舗は既定で `dryRun: true` なので、本番化は admin が画面またはシートで行う運用になる。
  既に本番稼働中の店舗の値は変わらない。
