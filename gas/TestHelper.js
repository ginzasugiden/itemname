/**
 * TestHelper.gs
 * テスト・診断用関数（GASエディタに追加して使用）
 * 
 * ★ このファイルをGASプロジェクトに追加すると
 *   各テストを個別に実行できます
 * 
 * [MT] diagMultiTenant() / migrateSheets_240364() 追加
 */

// ================================================================
//  Step 1: 全体ヘルスチェック（最初にこれを実行）
// ================================================================

function healthCheck() {
  Logger.log('========================================');
  Logger.log('  商品名自動修正侍 ヘルスチェック');
  Logger.log('  実行日時: ' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  Logger.log('========================================');
  
  let allOk = true;
  
  // --- シート確認 ---
  Logger.log('\n--- シート確認 ---');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetNames = ['SETTINGS', 'EVENTS', 'TARGET_ITEMS', 'LOG', 'BACKUP'];
  
  for (const name of sheetNames) {
    const sheet = ss.getSheetByName(name);
    if (sheet) {
      const rows = sheet.getLastRow() - 1; // ヘッダー除く
      Logger.log('  ? ' + name + ': ' + rows + '件');
    } else {
      Logger.log('  ? ' + name + ': シートなし');
      allOk = false;
    }
  }
  
  // --- MT用シート確認 ---
  Logger.log('\n--- マルチテナントシート確認 ---');
  try {
    const stores = getAllActiveStores();
    for (const store of stores) {
      Logger.log('  店舗: ' + store.sname + ' (sid: ' + store.sid + ')');
      const mtSheets = ['S_' + store.sid, 'T_' + store.sid, 'L_' + store.sid, 'B_' + store.sid];
      for (const mtName of mtSheets) {
        const sheet = ss.getSheetByName(mtName);
        if (sheet) {
          Logger.log('    ? ' + mtName + ': ' + (sheet.getLastRow() - 1) + '件');
        } else {
          Logger.log('    ?? ' + mtName + ': 未作成（setup()で作成されます）');
        }
      }
    }
  } catch (e) {
    Logger.log('  ?? マルチテナント情報取得エラー: ' + e.message);
  }
  
  // --- API認証情報 ---
  Logger.log('\n--- API認証情報（ScriptProperties） ---');
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('RAKUTEN_SERVICE_SECRET');
  const license = props.getProperty('RAKUTEN_LICENSE_KEY');
  
  if (secret && license) {
    Logger.log('  ? RAKUTEN_SERVICE_SECRET: 設定済み (' + secret.substring(0, 8) + '...)');
    Logger.log('  ? RAKUTEN_LICENSE_KEY: 設定済み (' + license.substring(0, 8) + '...)');
  } else {
    Logger.log('  ?? API認証情報が未設定（MT版ではapi_keyシートから取得するため任意）');
  }
  
  // --- 設定内容 ---
  Logger.log('\n--- 現在の設定 ---');
  try {
    const settings = loadSettings();
    Logger.log('  mode: ' + settings.mode);
    Logger.log('  dryRun: ' + settings.dryRun + (settings.dryRun ? ' ? 安全' : ' ?? 本番モード'));
    Logger.log('  maxItemsPerRun: ' + settings.maxItemsPerRun);
    Logger.log('  maxTitleZenkaku: ' + settings.maxTitleZenkaku);
    Logger.log('  notifySlack: ' + settings.notifySlack);
    Logger.log('  notifyEmail: ' + settings.notifyEmail);
  } catch (e) {
    Logger.log('  ? 設定読込エラー: ' + e.message);
    allOk = false;
  }
  
  // --- イベント ---
  Logger.log('\n--- イベント状況 ---');
  try {
    const events = loadEvents();
    const now = new Date();
    const activeEvents = events.filter(e => now >= e.startDatetime && now <= e.endDatetime);
    const futureEvents = events.filter(e => e.startDatetime > now);
    
    Logger.log('  有効イベント総数: ' + events.length);
    Logger.log('  現在適用中: ' + activeEvents.length + '件');
    if (activeEvents.length > 0) {
      activeEvents.forEach(e => Logger.log('    → ' + e.eventKey + ' ' + e.prefixLong));
    }
    Logger.log('  今後の予定: ' + futureEvents.length + '件');
    if (futureEvents.length > 0) {
      const next = futureEvents.sort((a, b) => a.startDatetime - b.startDatetime)[0];
      Logger.log('    次回: ' + next.eventKey + ' ' + next.startDatetime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
    }
  } catch (e) {
    Logger.log('  ? イベント読込エラー: ' + e.message);
    allOk = false;
  }
  
  // --- トリガー ---
  Logger.log('\n--- トリガー ---');
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('  設定数: ' + triggers.length);
  for (const trigger of triggers) {
    Logger.log('  - ' + trigger.getHandlerFunction() + ' (' + trigger.getTriggerSource() + ')');
  }
  if (triggers.length === 0) {
    Logger.log('  ?? トリガーが未設定（手動実行のみ）');
  }
  
  // --- 結果 ---
  Logger.log('\n========================================');
  if (allOk) {
    Logger.log('  ? ヘルスチェック: 全項目OK');
  } else {
    Logger.log('  ? ヘルスチェック: 問題あり（上記を確認）');
  }
  Logger.log('========================================');
}


// ================================================================
//  Step 2: API接続テスト
// ================================================================

function testStep2_ApiConnection() {
  Logger.log('=== Step 2: API接続テスト ===\n');
  
  // 認証ヘッダー生成テスト
  try {
    const header = buildAuthHeader_();
    Logger.log('? 認証ヘッダー生成OK: ' + header.substring(0, 20) + '...');
  } catch (e) {
    Logger.log('? 認証ヘッダー生成失敗: ' + e.message);
    return;
  }
  
  // 検索APIテスト
  Logger.log('\n商品検索API テスト中...');
  const searchResult = searchItems({ hits: 1 });
  
  if (searchResult.success) {
    Logger.log('? 検索API: 成功');
    Logger.log('  総商品数: ' + searchResult.numFound);
    
    if (searchResult.items.length > 0) {
      const item = searchResult.items[0].item || searchResult.items[0];
      Logger.log('  サンプル商品:');
      Logger.log('    manageNumber: ' + (item.manageNumber || 'N/A'));
      Logger.log('    title: ' + (item.title || 'N/A'));
      Logger.log('    全角換算: ' + calcZenkakuLength(item.title || '') + '文字');
    }
  } else {
    Logger.log('? 検索API: 失敗');
    Logger.log('  エラー: ' + JSON.stringify(searchResult.error));
  }
}


// ================================================================
//  Step 3: 商品取得テスト
// ================================================================

function testStep3_GetItem() {
  Logger.log('=== Step 3: 商品取得テスト ===\n');
  
  const targetItems = loadTargetItems();
  Logger.log('TARGET_ITEMS登録数: ' + targetItems.length);
  
  if (targetItems.length === 0) {
    Logger.log('? TARGET_ITEMSシートに商品がありません');
    Logger.log('  → 先に商品管理番号を1件以上登録してください');
    return;
  }
  
  // 最初の商品を取得テスト
  const testItem = targetItems[0];
  Logger.log('\nテスト対象: ' + testItem.itemManageNumber);
  
  const result = getItem(testItem.itemManageNumber);
  
  if (result.success) {
    Logger.log('? 商品取得成功');
    Logger.log('  title: ' + result.item.title);
    Logger.log('  全角換算: ' + calcZenkakuLength(result.item.title) + '文字');
    
    // prefix除去テスト
    const baseTitle = stripEventPrefixes(result.item.title);
    Logger.log('\n  prefix除去後: ' + baseTitle);
    Logger.log('  除去後全角換算: ' + calcZenkakuLength(baseTitle) + '文字');
    
    if (baseTitle !== result.item.title) {
      Logger.log('  → イベントprefixが検出されました');
    } else {
      Logger.log('  → 現在prefixなし');
    }
  } else {
    Logger.log('? 商品取得失敗: ' + JSON.stringify(result.error));
  }
}


// ================================================================
//  Step 4: イベント判定テスト
// ================================================================

function testStep4_EventDetection() {
  Logger.log('=== Step 4: イベント判定テスト ===\n');
  
  const settings = loadSettings();
  const events = loadEvents();
  const now = new Date();
  
  Logger.log('現在日時: ' + now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  Logger.log('有効イベント総数: ' + events.length);
  
  // 現在の適用イベント
  const currentEvent = getCurrentEvent(now, events, settings);
  
  if (currentEvent) {
    Logger.log('\n? 適用イベント:');
    Logger.log('  eventKey: ' + currentEvent.eventKey);
    Logger.log('  prefix(長): ' + currentEvent.prefixLong);
    Logger.log('  prefix(中): ' + currentEvent.prefixMid);
    Logger.log('  prefix(短): ' + currentEvent.prefixShort);
    Logger.log('  優先度: ' + currentEvent.priority);
  } else {
    Logger.log('\n?? 現在適用中のイベントなし（prefix除去モード）');
  }
  
  // 商品名生成シミュレーション
  if (currentEvent) {
    Logger.log('\n--- 商品名生成シミュレーション ---');
    const testTitles = [
      '観葉植物 パキラ 8号鉢 送料無料',
      '【送料無料】胡蝶蘭 3本立て ギフト プレゼント 開店祝い 就任祝い',
      '＼母の日限定／ アジサイ 鉢植え 5号鉢 2026年 ギフト 紫陽花 送料無料',
    ];
    
    const prefixCandidates = getPrefixCandidates(currentEvent);
    
    for (const title of testTitles) {
      const result = buildTitle(title, prefixCandidates, settings.maxTitleZenkaku, settings.keepNonEventBrackets);
      Logger.log('\n  元: ' + title);
      Logger.log('  → ' + result.title);
      Logger.log('    prefix: ' + result.prefix + ' / 短縮: ' + result.truncated + ' / 全角: ' + calcZenkakuLength(result.title));
    }
  }
}


// ================================================================
//  Step 5: DryRun実行テスト
// ================================================================

function testStep5_DryRun() {
  Logger.log('=== Step 5: DryRun実行テスト ===\n');
  
  // dryRunを強制true
  const settings = loadSettings();
  if (!settings.dryRun) {
    Logger.log('?? 設定がdryRun=falseですが、このテストではdryRun=trueで実行します');
  }
  
  Logger.log('実行開始...\n');
  
  // 安全のため testDryRun() を使用
  testDryRun();
  
  Logger.log('\n=== DryRun完了 ===');
  Logger.log('LOGシートとTARGET_ITEMSシートを確認してください');
  Logger.log('楽天RMSの商品名が変更されていないことを確認してください');
}


// ================================================================
//  Step 6: ログ確認（直近10件）
// ================================================================

function testStep6_CheckRecentLogs() {
  Logger.log('=== Step 6: 直近ログ確認 ===\n');
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('LOG');
  if (!sheet) {
    Logger.log('? LOGシートがありません');
    return;
  }
  
  const lastRow = sheet.getLastRow();
  const dataRows = lastRow - 1;
  Logger.log('ログ総数: ' + dataRows + '件\n');
  
  if (dataRows === 0) {
    Logger.log('ログがありません。DryRunを実行してください。');
    return;
  }
  
  // 最新10件を表示
  const startRow = Math.max(2, lastRow - 9);
  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 8).getValues();
  
  Logger.log('--- 最新 ' + data.length + ' 件 ---');
  Logger.log('');
  
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const ts = row[0] instanceof Date
      ? row[0].toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : row[0];
    
    Logger.log(
      ts + ' | ' +
      (row[1] || '-').toString().substring(0, 20) + ' | ' +
      (row[5] || '-') + ' | ' +
      (row[6] || '-') + ' | ' +
      (row[7] || '-')
    );
  }
}


// ================================================================
//  [MT] マルチテナント診断
// ================================================================

/**
 * マルチテナント環境の診断
 */
function diagMultiTenant() {
  Logger.log('=== マルチテナント診断 ===\n');
  
  // 1. 店舗一覧
  Logger.log('--- 登録店舗 ---');
  try {
    const stores = getAllActiveStores();
    Logger.log('有効店舗数: ' + stores.length);
    
    for (const store of stores) {
      Logger.log('  sid: ' + store.sid + ' | ' + store.sname + ' | id: ' + store.id);
      Logger.log('    serviceSecret: ' + (store.serviceSecret ? store.serviceSecret.substring(0, 8) + '...' : '未設定'));
      Logger.log('    licenseKey: ' + (store.licenseKey ? store.licenseKey.substring(0, 8) + '...' : '未設定'));
    }
    
    if (stores.length === 0) {
      Logger.log('  ? 有効な店舗がありません');
      Logger.log('  → api_keyシートを確認してください');
      return;
    }
  } catch (e) {
    Logger.log('? 店舗一覧取得エラー: ' + e.message);
    return;
  }
  
  // 2. 各店舗のシート存在確認
  Logger.log('\n--- 店舗別シート確認 ---');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stores = getAllActiveStores();
  
  for (const store of stores) {
    Logger.log('店舗: ' + store.sname + ' (sid: ' + store.sid + ')');
    
    const sheetChecks = [
      { type: 'SETTINGS', name: 'S_' + store.sid },
      { type: 'TARGET_ITEMS', name: 'T_' + store.sid },
      { type: 'LOG', name: 'L_' + store.sid },
      { type: 'BACKUP', name: 'B_' + store.sid },
    ];
    
    for (const check of sheetChecks) {
      const sheet = ss.getSheetByName(check.name);
      if (sheet) {
        Logger.log('  ? ' + check.name + ': ' + (sheet.getLastRow() - 1) + '件');
      } else {
        Logger.log('  ? ' + check.name + ': 未作成');
      }
    }
  }
  
  // 3. EVENTSシート（共通）
  Logger.log('\n--- 共通シート ---');
  const eventsSheet = ss.getSheetByName('EVENTS');
  if (eventsSheet) {
    Logger.log('  ? EVENTS: ' + (eventsSheet.getLastRow() - 1) + '件');
  } else {
    Logger.log('  ? EVENTS: 未作成');
  }
  
  Logger.log('\n=== 診断完了 ===');
}

/**
 * レガシーシートをMT用にリネーム（銀座東京フラワー sid:240364）
 * ※ 一度だけ実行してください
 */
function migrateSheets_240364() {
  const sid = '240364';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  Logger.log('=== シートマイグレーション (sid: ' + sid + ') ===\n');
  
  const migrations = [
    { from: 'SETTINGS', to: 'S_' + sid },
    { from: 'TARGET_ITEMS', to: 'T_' + sid },
    { from: 'LOG', to: 'L_' + sid },
    { from: 'BACKUP', to: 'B_' + sid },
  ];
  
  for (const m of migrations) {
    const sheet = ss.getSheetByName(m.from);
    const existing = ss.getSheetByName(m.to);
    
    if (existing) {
      Logger.log('?? ' + m.to + ' は既に存在します。スキップ');
      continue;
    }
    
    if (sheet) {
      sheet.setName(m.to);
      Logger.log('? ' + m.from + ' → ' + m.to + ' リネーム完了');
    } else {
      Logger.log('?? ' + m.from + ' が見つかりません。スキップ');
    }
  }
  
  Logger.log('\n=== マイグレーション完了 ===');
  Logger.log('EVENTS シートは全店舗共通のためそのまま');
}

/**
 * 全店舗のAPI接続テスト
 */
function testStoreApiConnection() {
  Logger.log('=== 全店舗API接続テスト ===\n');
  
  const stores = getAllActiveStores();
  
  if (stores.length === 0) {
    Logger.log('? 有効な店舗がありません');
    return;
  }
  
  for (const store of stores) {
    Logger.log('--- ' + store.sname + ' (sid: ' + store.sid + ') ---');
    
    const credentials = {
      serviceSecret: store.serviceSecret,
      licenseKey: store.licenseKey,
    };
    
    try {
      const result = searchItems({ hits: 1 }, credentials);
      
      if (result.success) {
        Logger.log('  ? API接続OK (商品数: ' + result.numFound + ')');
      } else {
        Logger.log('  ? API接続失敗: ' + JSON.stringify(result.error));
      }
    } catch (e) {
      Logger.log('  ? エラー: ' + e.message);
    }
  }
}

/**
 * 新店舗のシートを初期化
 */
function setupNewStore(sid) {
  if (!sid) {
    Logger.log('? sidを指定してください。例: setupNewStore("123456")');
    return;
  }
  
  Logger.log('=== 新店舗セットアップ (sid: ' + sid + ') ===');
  
  initializeAllSheets(sid);
  
  Logger.log('? 作成完了:');
  Logger.log('  S_' + sid + ' (設定)');
  Logger.log('  T_' + sid + ' (対象商品)');
  Logger.log('  L_' + sid + ' (ログ)');
  Logger.log('  B_' + sid + ' (バックアップ)');
}

function setupNakano() {
  setupNewStore('193846');
}


// ================================================================
//  デプロイURL確認
// ================================================================

function checkDeployment() {
  Logger.log('=== デプロイ情報確認 ===\n');
  Logger.log('このスクリプトのID: ' + ScriptApp.getScriptId());
  Logger.log('');
  Logger.log('?? フロントエンド (app.js) の API_URL が');
  Logger.log('  最新のデプロイURLと一致しているか確認してください。');
  Logger.log('');
  Logger.log('確認方法:');
  Logger.log('  1. GASエディタ → デプロイ → デプロイを管理');
  Logger.log('  2. 表示されるウェブアプリURLをコピー');
  Logger.log('  3. GitHub の js/app.js 1行目の API_URL と比較');
}