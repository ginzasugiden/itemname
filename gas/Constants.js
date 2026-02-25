/**
 * Constants.gs
 * 定数定義・設定値
 * 
 * [MT-1] マルチテナント対応追加
 *   - SHEET_PREFIX / COMMON_SHEETS / resolveSheetName_() 追加
 *   - 既存の定数はすべてそのまま維持
 */

// ==================== デフォルト設定 ====================
const DEFAULT_SETTINGS = {
  mode: 'TARGET_LIST',           // TARGET_LIST / ALL_ACTIVE
  dryRun: true,                  // 初回は必ずtrue
  maxTitleZenkaku: 127,          // 全角換算最大文字数
  keepNonEventBrackets: true,    // イベント以外の【】を保持
  shopMultiplierEnabled: false,  // 当店倍率有効化
  shopMultiplierRate: 2,         // 当店倍率
  maxItemsPerRun: 500,           // 1回の実行で処理する最大件数
  batchSize: 20,                 // items.update のバッチサイズ
  apiSleepMs: 1000,              // API呼び出し間隔(ms)
  logRetentionDays: 90,          // ログ保持日数
  notifySlack: false,
  notifyEmail: false,
};

// ==================== シート名 ====================
const SHEET_NAMES = {
  SETTINGS: 'SETTINGS',
  EVENTS: 'EVENTS',
  TARGET_ITEMS: 'TARGET_ITEMS',
  LOG: 'LOG',
  BACKUP: 'BACKUP',
};

// ==================== [MT-1] マルチテナント用シートプレフィックス ====================

/**
 * 店舗別シートのプレフィックス
 * 実際のシート名: S_240364, T_240364, L_240364, B_240364
 */
const SHEET_PREFIX = {
  SETTINGS: 'S',
  TARGET_ITEMS: 'T',
  LOG: 'L',
  BACKUP: 'B',
};

/**
 * 全店舗共通シート（マルチテナントでも共有）
 */
const COMMON_SHEETS = {
  EVENTS: 'EVENTS',
};

/**
 * [MT-1] シートタイプからシート名を取得（sid対応）
 * sidが指定されている場合: S_240364 形式
 * sidが未指定の場合: SETTINGS 形式（レガシーフォールバック）
 */
function resolveSheetName_(sheetType, sid) {
  if (sid && SHEET_PREFIX[sheetType]) {
    return SHEET_PREFIX[sheetType] + '_' + sid;
  }
  return SHEET_NAMES[sheetType] || sheetType;
}

// ==================== イベントキー ====================
const EVENT_KEYS = {
  MARATHON: 'MARATHON',
  FIVE_DAY: 'FIVE_DAY',
  ZERO_DAY: 'ZERO_DAY',
  ICHIBA_DAY: 'ICHIBA_DAY',
  WONDERFUL_DAY: 'WONDERFUL_DAY',
  SHOP_MULTIPLIER: 'SHOP_MULTIPLIER',
};

// ==================== Prefix候補 ====================
const PREFIX_TEMPLATES = {
  MARATHON: {
    long: '【お買い物マラソン】',
    mid: '【マラソン】',
    short: '【SALE】',
  },
  FIVE_DAY: {
    long: '【本日5の日】',
    mid: '【5の日】',
    short: '【5】',
  },
  ZERO_DAY: {
    long: '【本日0の日】',
    mid: '【0の日】',
    short: '【0】',
  },
  ICHIBA_DAY: {
    long: '【いちばの日】',
    mid: '【市場の日】',
    short: '【市】',
  },
  WONDERFUL_DAY: {
    long: '【ワンダフルデー】',
    mid: '【Wデー】',
    short: '【WD】',
  },
  SHOP_MULTIPLIER: {
    // 動的に生成: 【当店2倍】【店2倍】【2倍】
    long: null,
    mid: null,
    short: null,
  },
};

// ==================== イベントPrefix除去パターン ====================
const EVENT_PREFIX_PATTERNS = [
  // 5の日
  /^【本日5の日】/,
  /^【5の日】/,
  /^【5】/,
  // 0の日
  /^【本日0の日】/,
  /^【0の日】/,
  /^【0】/,
  // マラソン
  /^【お買い物マラソン】/,
  /^【マラソン】/,
  /^【SALE】/,
  // いちばの日
  /^【いちばの日】/,
  /^【市場の日】/,
  /^【市】/,
  // ワンダフルデー
  /^【ワンダフルデー】/,
  /^【Wデー】/,
  /^【WD】/,
  // 当店倍率
  /^【当店[0-9]+倍】/,
  /^【店[0-9]+倍】/,
  /^【[0-9]+倍】/,
];

// ==================== 削除候補の装飾【】 ====================
const REMOVABLE_BRACKETS = [
  // 配送系（優先削除）
  '【送料無料】',
  '【即日発送】',
  '【あす楽対応】',
  '【あす楽】',
  '【翌日配送】',
  // サービス系
  '【ギフト対応】',
  '【ラッピング無料】',
  '【のし対応】',
  '【メッセージカード無料】',
  // プロモ系
  '【ポイント消化】',
  '【訳あり】',
  '【在庫処分】',
  '【特価】',
  '【SALE】', // イベント以外のSALE
];

// ==================== 末尾削除候補キーワード ====================
const TAIL_KEYWORDS_TO_REMOVE = [
  // 検索用短縮キーワード
  'haha',
  'xmas',
  'gift',
  'mothersday',
  'fathersday',
  // イベント名
  'バレンタイン',
  'ホワイトデー',
  'クリスマス',
  'お歳暮',
  'お中元',
  '母の日',
  '父の日',
  '敬老の日',
  // 年月
  /\d{4}年/,
  /\d{1,2}月/,
];

// ==================== 楽天API設定 ====================
const RAKUTEN_API = {
  BASE_URL: 'https://api.rms.rakuten.co.jp/es/2.0',
  ENDPOINTS: {
    ITEM_GET: '/item/get',
    ITEM_SEARCH: '/item/search',
    ITEM_UPDATE: '/item/update',
    ITEMS_UPDATE: '/items/update',
  },
  MAX_RETRY: 3,
  RETRY_DELAY_MS: 2000,
};

// ==================== ログアクション ====================
const LOG_ACTIONS = {
  INSERT: 'INSERT',      // prefix挿入
  REMOVE: 'REMOVE',      // prefix除去（復元）
  SKIP: 'SKIP',          // 変更不要でスキップ
  ERROR: 'ERROR',        // エラー発生
};

// ==================== ログステータス ====================
const LOG_STATUS = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  DRY_RUN: 'DRY_RUN',
  SKIPPED: 'SKIPPED',
  MANUAL_CHANGE: 'MANUAL_CHANGE',
};
