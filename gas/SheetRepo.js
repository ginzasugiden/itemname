/**
 * SheetRepo.gs
 * スプレッドシート操作（設定読込/対象商品取得/ログ書込/バックアップ）
 * 
 * [MT-2] マルチテナント対応
 *   - 全関数にオプション引数 sid を追加
 *   - sid指定時: S_{sid}, T_{sid}, L_{sid}, B_{sid} シートを使用
 *   - sid省略時: SETTINGS, TARGET_ITEMS 等レガシーシート名にフォールバック
 *   - EVENTS は全店舗共通のまま
 *   - getAllActiveStores() 追加（トリガー用に全有効店舗を取得）
 */

/**
 * スプレッドシートを取得
 */
function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * シートを取得（なければ作成）
 * [MT-2] sid対応: sheetNameがSHEET_NAMESキーの場合、sidに応じてシート名を解決
 */
function getOrCreateSheet_(sheetName, sid) {
  const ss = getSpreadsheet_();
  
  // シート名を解決
  let resolvedName;
  if (SHEET_NAMES[sheetName]) {
    // SHEET_NAMESのキーが渡された場合（'SETTINGS', 'TARGET_ITEMS'等）
    resolvedName = resolveSheetName_(sheetName, sid);
  } else {
    // シート名がそのまま渡された場合（レガシー互換）
    resolvedName = sheetName;
  }
  
  let sheet = ss.getSheetByName(resolvedName);
  if (!sheet) {
    sheet = ss.insertSheet(resolvedName);
    // 初期化は元のsheetType（SETTINGS等）で判定
    initializeSheet_(sheet, SHEET_NAMES[sheetName] ? sheetName : resolvedName);
    Logger.log('シート作成: ' + resolvedName);
  }
  return sheet;
}

/**
 * シート初期化（ヘッダー設定）
 */
function initializeSheet_(sheet, sheetName) {
  const headers = {
    'SETTINGS': ['key', 'value'],
    'EVENTS': ['eventKey', 'startDatetime', 'endDatetime', 'priority', 'prefixLong', 'prefixMid', 'prefixShort', 'enabled'],
    'TARGET_ITEMS': ['itemManageNumber', 'baseTitle', 'currentTitle', 'lastUpdated', 'status'],
    'LOG': ['timestamp', 'itemManageNumber', 'oldTitle', 'newTitle', 'eventKey', 'action', 'status', 'message'],
    'BACKUP': ['itemManageNumber', 'originalTitle', 'createdAt', 'lastVerified'],
  };
  
  if (headers[sheetName]) {
    sheet.getRange(1, 1, 1, headers[sheetName].length).setValues([headers[sheetName]]);
    sheet.getRange(1, 1, 1, headers[sheetName].length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // SETTINGSシート新規作成時にデフォルト値を書き込む
  if (sheetName === 'SETTINGS') {
    const rows = Object.entries(DEFAULT_SETTINGS).map(function(entry) {
      return [entry[0], entry[1]];
    });
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 2).setValues(rows);
      Logger.log('デフォルト設定を書き込みました（' + rows.length + '件）');
    }
  }
}

// ==================== 設定読込 ====================

/**
 * SETTINGSシートから設定を読み込む
 * [MT-2] sid対応
 */
function loadSettings(sid) {
  const sheet = getOrCreateSheet_('SETTINGS', sid);
  const data = sheet.getDataRange().getValues();
  const settings = Object.assign({}, DEFAULT_SETTINGS);
  
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    
    if (key && value !== undefined && value !== '') {
      // 型変換
      if (value === 'TRUE' || value === true) value = true;
      else if (value === 'FALSE' || value === false) value = false;
      else if (!isNaN(value) && value !== '') value = Number(value);
      
      settings[key] = value;
    }
  }
  
  return settings;
}

/**
 * 設定を保存（初期化用）
 * [MT-2] sid対応
 */
function saveDefaultSettings(sid) {
  const sheet = getOrCreateSheet_('SETTINGS', sid);
  sheet.clear();
  initializeSheet_(sheet, 'SETTINGS');
  
  const rows = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, value]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }
}

/**
 * 設定を保存（部分更新）
 * [MT-2] sid対応
 */
function saveSettings(settings, sid) {
  const sheet = getOrCreateSheet_('SETTINGS', sid);
  const data = sheet.getDataRange().getValues();

  // 行が空（ヘッダーのみ）の場合、デフォルト設定を書き込む
  if (data.length <= 1) {
    const rows = Object.entries(DEFAULT_SETTINGS).map(function(entry) {
      return [entry[0], entry[1]];
    });
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 2).setValues(rows);
      Logger.log('設定行が空のためデフォルト設定を書き込みました (sid: ' + (sid || 'legacy') + ')');
    }
    // 書き込んだデータを再取得
    data.length = 0;
    sheet.getDataRange().getValues().forEach(function(row) { data.push(row); });
  }

  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    if (settings.hasOwnProperty(key)) {
      sheet.getRange(i + 1, 2).setValue(settings[key]);
    }
  }
}

// ==================== イベント読込（共通 / sid不要） ====================

/**
 * EVENTSシートからイベント一覧を読み込む
 * ※ EVENTSは全店舗共通なのでsid不要
 */
function loadEvents() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const data = sheet.getDataRange().getValues();
  const events = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue; // eventKeyが空ならスキップ
    
    const event = {
      eventKey: row[0],
      startDatetime: row[1] instanceof Date ? row[1] : new Date(row[1]),
      endDatetime: row[2] instanceof Date ? row[2] : new Date(row[2]),
      priority: Number(row[3]) || 99,
      prefixLong: row[4] || '',
      prefixMid: row[5] || '',
      prefixShort: row[6] || '',
      enabled: row[7] === true || row[7] === 'TRUE',
    };
    
    if (event.enabled && !isNaN(event.startDatetime) && !isNaN(event.endDatetime)) {
      events.push(event);
    }
  }
  
  return events;
}

/**
 * サンプルイベントを設定（初期化用）
 */
function saveSampleEvents() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  sheet.clear();
  initializeSheet_(sheet, SHEET_NAMES.EVENTS);
  
  // 2026年1月のサンプルイベント
  const sampleEvents = [
    ['WONDERFUL_DAY', '2026/01/01 00:00:00', '2026/01/01 23:59:59', 4, '【ワンダフルデー】', '【Wデー】', '【WD】', true],
    ['FIVE_DAY', '2026/01/05 00:00:00', '2026/01/05 23:59:59', 2, '【本日5の日】', '【5の日】', '【5】', true],
    ['MARATHON', '2026/01/09 20:00:00', '2026/01/16 01:59:59', 1, '【お買い物マラソン】', '【マラソン】', '【SALE】', true],
    ['ZERO_DAY', '2026/01/10 00:00:00', '2026/01/10 23:59:59', 2, '【本日0の日】', '【0の日】', '【0】', true],
    ['FIVE_DAY', '2026/01/15 00:00:00', '2026/01/15 23:59:59', 2, '【本日5の日】', '【5の日】', '【5】', true],
    ['ICHIBA_DAY', '2026/01/18 00:00:00', '2026/01/18 23:59:59', 3, '【いちばの日】', '【市場の日】', '【市】', true],
    ['ZERO_DAY', '2026/01/20 00:00:00', '2026/01/20 23:59:59', 2, '【本日0の日】', '【0の日】', '【0】', true],
    ['MARATHON', '2026/01/24 20:00:00', '2026/01/29 01:59:59', 1, '【お買い物マラソン】', '【マラソン】', '【SALE】', true],
    ['FIVE_DAY', '2026/01/25 00:00:00', '2026/01/25 23:59:59', 2, '【本日5の日】', '【5の日】', '【5】', true],
    ['ZERO_DAY', '2026/01/30 00:00:00', '2026/01/30 23:59:59', 2, '【本日0の日】', '【0の日】', '【0】', true],
  ];
  
  sheet.getRange(2, 1, sampleEvents.length, sampleEvents[0].length).setValues(sampleEvents);
}


/**
 * 定期イベントを自動生成（2ヶ月分）
 * - 1日: ワンダフルデー
 * - 5日, 15日, 25日: 5の日
 * - 10日, 20日, 30日: 0の日
 * - 18日: いちばの日
 */
function generateRecurringEvents() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  
  // 自動生成対象のイベントキー（これらは再生成される）
  const autoGeneratedKeys = new Set(['WONDERFUL_DAY', 'FIVE_DAY', 'ZERO_DAY', 'ICHIBA_DAY']);

  // 自動生成対象以外のイベントを保持（マラソン・カスタム等）
  const existingData = sheet.getDataRange().getValues();
  const manualEvents = [];
  for (let i = 1; i < existingData.length; i++) {
    if (existingData[i][0] && !autoGeneratedKeys.has(existingData[i][0])) {
      manualEvents.push(existingData[i]);
    }
  }
  
  // シートをクリアしてヘッダー再設定
  sheet.clear();
  initializeSheet_(sheet, SHEET_NAMES.EVENTS);
  
  // 2ヶ月分の日付を生成
  const today = new Date();
  const events = [];
  
  for (let monthOffset = 0; monthOffset < 2; monthOffset++) {
    const targetDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth(); // 0-indexed
    
    // 月の最終日を取得
    const lastDay = new Date(year, month + 1, 0).getDate();
    
    // 1日: ワンダフルデー
    events.push(createEventRow('WONDERFUL_DAY', year, month, 1));
    
    // 5の日: 5日, 15日, 25日
    events.push(createEventRow('FIVE_DAY', year, month, 5));
    events.push(createEventRow('FIVE_DAY', year, month, 15));
    events.push(createEventRow('FIVE_DAY', year, month, 25));
    
    // 0の日: 10日, 20日, 30日（30日は月による）
    events.push(createEventRow('ZERO_DAY', year, month, 10));
    events.push(createEventRow('ZERO_DAY', year, month, 20));
    if (lastDay >= 30) {
      events.push(createEventRow('ZERO_DAY', year, month, 30));
    }
    
    // 18日: いちばの日
    events.push(createEventRow('ICHIBA_DAY', year, month, 18));
  }
  
  // 日付順にソート
  events.sort((a, b) => new Date(a[1]) - new Date(b[1]));
  
  // 手動登録イベントを追加（日付順に挿入）
  const allEvents = [...events, ...manualEvents];
  allEvents.sort((a, b) => new Date(a[1]) - new Date(b[1]));

  // シートに書き込み
  if (allEvents.length > 0) {
    sheet.getRange(2, 1, allEvents.length, allEvents[0].length).setValues(allEvents);
  }

  Logger.log('=== イベント自動生成完了 ===');
  Logger.log('生成件数: ' + events.length);
  Logger.log('手動登録（保持）: ' + manualEvents.length + '件');
  Logger.log('合計: ' + allEvents.length + '件');
}

/**
 * イベント行データを作成
 */
function createEventRow(eventKey, year, month, day) {
  const startDate = new Date(year, month, day, 0, 0, 0);
  const endDate = new Date(year, month, day, 23, 59, 59);
  
  const prefixes = {
    'WONDERFUL_DAY': { long: '【ワンダフルデー】', mid: '【Wデー】', short: '【WD】', priority: 4 },
    'FIVE_DAY': { long: '【本日5の日】', mid: '【5の日】', short: '【5】', priority: 2 },
    'ZERO_DAY': { long: '【本日0の日】', mid: '【0の日】', short: '【0】', priority: 2 },
    'ICHIBA_DAY': { long: '【いちばの日】', mid: '【市場の日】', short: '【市】', priority: 3 },
  };
  
  const p = prefixes[eventKey];
  
  return [
    eventKey,
    formatDatetime_(startDate),
    formatDatetime_(endDate),
    p.priority,
    p.long,
    p.mid,
    p.short,
    true
  ];
}

/**
 * 日時をフォーマット
 */
function formatDatetime_(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

/**
 * マラソンイベントを手動追加（ヘルパー関数）
 * 使用例: addMarathonEvent('2026/02/01 20:00:00', '2026/02/06 01:59:59')
 */
function addMarathonEvent(startDatetimeStr, endDatetimeStr) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const lastRow = sheet.getLastRow();

  const row = [
    'MARATHON',
    startDatetimeStr,
    endDatetimeStr,
    1, // 最優先
    '【お買い物マラソン】',
    '【マラソン】',
    '【SALE】',
    true
  ];

  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
  Logger.log('マラソンイベント追加: ' + startDatetimeStr + ' ～ ' + endDatetimeStr);
}

/**
 * EVENTSシートにイベント行を追加（汎用）
 * @param {Object} eventData - { eventKey, startDatetime, endDatetime, priority, prefixLong, prefixMid, prefixShort }
 */
function addEventRow(eventData) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const lastRow = sheet.getLastRow();

  const row = [
    eventData.eventKey,
    eventData.startDatetime,
    eventData.endDatetime,
    eventData.priority || 4,
    eventData.prefixLong || '',
    eventData.prefixMid || '',
    eventData.prefixShort || '',
    true
  ];

  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
  Logger.log('イベント追加: ' + eventData.eventKey + ' ' + eventData.startDatetime + ' ～ ' + eventData.endDatetime);
}

/**
 * EVENTSシートから全イベントを読み込む（disabled含む、行番号付き）
 * フロントエンド管理画面用
 */
function loadAllEvents() {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const data = sheet.getDataRange().getValues();
  const events = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    events.push({
      rowIndex: i + 1, // 1-indexed sheet row
      eventKey: row[0],
      startDatetime: row[1] instanceof Date ? row[1] : new Date(row[1]),
      endDatetime: row[2] instanceof Date ? row[2] : new Date(row[2]),
      priority: Number(row[3]) || 99,
      prefixLong: row[4] || '',
      prefixMid: row[5] || '',
      prefixShort: row[6] || '',
      enabled: row[7] === true || row[7] === 'TRUE',
    });
  }

  return events;
}

/**
 * EVENTSシートから指定行を削除
 * @param {number} rowIndex - 1-indexed シート行番号
 */
function deleteEventRow(rowIndex) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const lastRow = sheet.getLastRow();

  if (rowIndex < 2 || rowIndex > lastRow) {
    throw new Error('無効な行番号です: ' + rowIndex);
  }

  sheet.deleteRow(rowIndex);
  Logger.log('イベント行削除: row ' + rowIndex);
}

/**
 * EVENTSシートの指定行のenabledを切り替え
 * @param {number} rowIndex - 1-indexed シート行番号
 * @return {boolean} 切り替え後のenabled値
 */
function toggleEventRow(rowIndex) {
  const sheet = getOrCreateSheet_(SHEET_NAMES.EVENTS);
  const lastRow = sheet.getLastRow();

  if (rowIndex < 2 || rowIndex > lastRow) {
    throw new Error('無効な行番号です: ' + rowIndex);
  }

  // enabledは8列目（H列）
  const cell = sheet.getRange(rowIndex, 8);
  const current = cell.getValue();
  const newValue = !(current === true || current === 'TRUE');
  cell.setValue(newValue);

  Logger.log('イベント enabled 切替: row ' + rowIndex + ' → ' + newValue);
  return newValue;
}


// ==================== 対象商品読込 ====================

/**
 * TARGET_ITEMSシートから対象商品リストを読み込む
 * [MT-2] sid対応
 */
function loadTargetItems(sid) {
  const sheet = getOrCreateSheet_('TARGET_ITEMS', sid);
  const data = sheet.getDataRange().getValues();
  const items = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    
    items.push({
      rowIndex: i + 1, // 1-indexed
      itemManageNumber: String(row[0]).trim(),
      baseTitle: row[1] || '',
      currentTitle: row[2] || '',
      lastUpdated: row[3] || null,
      status: row[4] || '',
    });
  }
  
  return items;
}

/**
 * TARGET_ITEMSシートを更新
 * [MT-2] sid対応
 */
function updateTargetItemRow(rowIndex, updates, sid) {
  const sheet = getOrCreateSheet_('TARGET_ITEMS', sid);
  
  if (updates.baseTitle !== undefined) {
    sheet.getRange(rowIndex, 2).setValue(updates.baseTitle);
  }
  if (updates.currentTitle !== undefined) {
    sheet.getRange(rowIndex, 3).setValue(updates.currentTitle);
  }
  if (updates.lastUpdated !== undefined) {
    sheet.getRange(rowIndex, 4).setValue(updates.lastUpdated);
  }
  if (updates.status !== undefined) {
    sheet.getRange(rowIndex, 5).setValue(updates.status);
  }
}

// ==================== バックアップ ====================

/**
 * バックアップを取得
 * [MT-2] sid対応
 */
function getBackup(itemManageNumber, sid) {
  const sheet = getOrCreateSheet_('BACKUP', sid);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === itemManageNumber) {
      return {
        rowIndex: i + 1,
        itemManageNumber: data[i][0],
        originalTitle: data[i][1],
        createdAt: data[i][2],
        lastVerified: data[i][3],
      };
    }
  }
  return null;
}

/**
 * バックアップを保存/更新
 * [MT-2] sid対応
 */
function saveBackup(itemManageNumber, originalTitle, sid) {
  const sheet = getOrCreateSheet_('BACKUP', sid);
  const existing = getBackup(itemManageNumber, sid);
  const now = new Date();
  
  if (existing) {
    // 既存の場合はlastVerifiedを更新
    sheet.getRange(existing.rowIndex, 4).setValue(now);
  } else {
    // 新規の場合は追加
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, 4).setValues([
      [itemManageNumber, originalTitle, now, now]
    ]);
  }
}

/**
 * バックアップをリセット（ヘッダー以外を全削除）
 * 次回実行時にバックアップが再作成され、手動変更検知がリセットされる
 * [MT-2] sid対応
 */
function resetBackups(sid) {
  const sheet = getOrCreateSheet_('BACKUP', sid);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    // 空行を削除（ヘッダーだけ残す）
    sheet.deleteRows(2, lastRow - 1);
  }
  Logger.log('バックアップをリセットしました' + (sid ? ' (sid: ' + sid + ')' : ''));
  return lastRow - 1; // 削除した行数
}

/**
 * 全バックアップを取得（マップ形式）
 * [MT-2] sid対応
 */
function getAllBackups(sid) {
  const sheet = getOrCreateSheet_('BACKUP', sid);
  const data = sheet.getDataRange().getValues();
  const backups = {};
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      backups[data[i][0]] = {
        originalTitle: data[i][1],
        createdAt: data[i][2],
        lastVerified: data[i][3],
      };
    }
  }
  return backups;
}

// ==================== ログ ====================

/**
 * ログを書き込む
 * [MT-2] sid対応
 */
function writeLog(logEntry, sid) {
  const sheet = getOrCreateSheet_('LOG', sid);
  const row = [
    formatDatetime_(logEntry.timestamp || new Date()),
    logEntry.itemManageNumber || '',
    logEntry.oldTitle || '',
    logEntry.newTitle || '',
    logEntry.eventKey || '',
    logEntry.action || '',
    logEntry.status || '',
    logEntry.message || '',
  ];
  
  sheet.appendRow(row);
}

/**
 * 複数ログを一括書き込み
 * [MT-2] sid対応
 */
function writeLogs(logEntries, sid) {
  if (!logEntries || logEntries.length === 0) return;
  
  const sheet = getOrCreateSheet_('LOG', sid);
  const rows = logEntries.map(entry => [
    formatDatetime_(entry.timestamp || new Date()),
    entry.itemManageNumber || '',
    entry.oldTitle || '',
    entry.newTitle || '',
    entry.eventKey || '',
    entry.action || '',
    entry.status || '',
    entry.message || '',
  ]);
  
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * 古いログを削除
 * [MT-2] sid対応
 */
function cleanOldLogs(retentionDays, sid) {
  const sheet = getOrCreateSheet_('LOG', sid);
  const data = sheet.getDataRange().getValues();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  const rowsToDelete = [];
  for (let i = data.length - 1; i >= 1; i--) {
    const timestamp = data[i][0];
    if (timestamp instanceof Date && timestamp < cutoffDate) {
      rowsToDelete.push(i + 1);
    }
  }
  
  // 逆順で削除（インデックスずれ防止）
  for (const rowIndex of rowsToDelete) {
    sheet.deleteRow(rowIndex);
  }
  
  return rowsToDelete.length;
}

// ==================== 初期化 ====================

/**
 * 全シートを初期化
 * [MT-2] sid対応
 */
function initializeAllSheets(sid) {
  saveDefaultSettings(sid);
  saveSampleEvents();
  getOrCreateSheet_('TARGET_ITEMS', sid);
  getOrCreateSheet_('LOG', sid);
  getOrCreateSheet_('BACKUP', sid);
  Logger.log('全シートを初期化しました' + (sid ? ' (sid: ' + sid + ')' : ''));
}

// ==================== [MT-2] 全店舗ID取得（トリガー用） ====================

/**
 * api_keyシートから全有効店舗のsid一覧を取得
 * @return {Array<Object>} [{sid, id, sname, serviceSecret, licenseKey}, ...]
 */
function getAllActiveStores() {
  const ss = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(AUTH_SHEET_NAME);
  
  if (!sheet) {
    Logger.log('api_keyシートが見つかりません');
    return [];
  }
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const colIndex = {};
  headers.forEach((header, index) => { colIndex[header] = index; });
  
  const stores = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    // 有効期限チェック
    const expiry = row[colIndex['expiry']];
    if (expiry) {
      const expiryDate = new Date(expiry);
      if (expiryDate < new Date()) continue;
    }
    
    // flagチェック（カラムがあれば）
    if (colIndex['flag'] !== undefined) {
      const flag = row[colIndex['flag']];
      if (flag === false || flag === 'FALSE' || flag === 'disabled') continue;
    }
    
    const sid = row[colIndex['sid']];
    if (!sid) continue;
    
    stores.push({
      sid: String(sid),
      id: row[colIndex['id']] || '',
      sname: row[colIndex['sname']] || '',
      serviceSecret: row[colIndex['serviceSecret']] || '',
      licenseKey: row[colIndex['licenseKey']] || '',
    });
  }
  
  return stores;
}
