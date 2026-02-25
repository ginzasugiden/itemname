/**
 * WebApi.gs
 * フロントエンドからの認証・設定取得・更新API
 * 
 * ===== 修正履歴 =====
 * [修正3] マルチテナント対応 - ログイン時に取得した認証情報をAPI呼び出しに渡す
 * [修正4] handleGetLogs_ - ログの取得順序を修正（最新から正しくlimit件取得）
 * [MT-3] マルチテナント統合
 *   - セッションにsidを保存（credentials + sid）
 *   - 全API操作でsidを取得し店舗別シートを参照
 *   - getUserContext_() ヘルパーで認証+sid+credentialsを一括取得
 */

// 認証用スプレッドシートID（スクリプトプロパティから取得）
const AUTH_SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('AUTH_SPREADSHEET_ID');
const AUTH_SHEET_NAME = 'api_key';

/**
 * GETリクエスト処理
 */
function doGet(e) {
  return handleRequest_(e);
}

/**
 * POSTリクエスト処理
 */
function doPost(e) {
  return handleRequest_(e);
}

/**
 * リクエスト処理のメインルーター
 */
function handleRequest_(e) {
  const response = { success: false, message: '', data: null };
  
  try {
    // パラメータ取得
    const params = e.parameter || {};
    const postData = e.postData ? JSON.parse(e.postData.contents) : {};
    const action = params.action || postData.action;
    
    switch (action) {
      case 'login':
        return handleLogin_(postData);
      
      case 'getSettings':
        return handleGetSettings_(postData);
      
      case 'updateSettings':
        return handleUpdateSettings_(postData);
      
      case 'getEvents':
        return handleGetEvents_(postData);
      
      case 'getLogs':
        return handleGetLogs_(postData);
      
      case 'runManual':
        return handleRunManual_(postData);
      
      // 対象商品操作
      case 'getTargetItems':
        return handleGetTargetItems_(postData);
      
      case 'addTargetItem':
        return handleAddTargetItem_(postData);
      
      case 'deleteTargetItem':
        return handleDeleteTargetItem_(postData);
      
      case 'bulkAddTargetItems':
        return handleBulkAddTargetItems_(postData);

      case 'resetBackups':
        return handleResetBackups_(postData);

      // イベント管理（管理者のみ）
      case 'generateEvents':
        return handleGenerateEvents_(postData);

      case 'addMarathonEvent':
        return handleAddMarathonEvent_(postData);

      case 'addEvent':
        return handleAddEvent_(postData);

      case 'deleteEvent':
        return handleDeleteEvent_(postData);

      case 'toggleEvent':
        return handleToggleEvent_(postData);

      default:
        response.message = '不明なアクション: ' + action;
        return createJsonResponse_(response);
    }
    
  } catch (error) {
    response.message = 'サーバーエラー: ' + error.message;
    return createJsonResponse_(response);
  }
}

/**
 * JSONレスポンスを作成
 */
function createJsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== [MT-3] ユーザーコンテキスト取得 ====================

/**
 * ユーザーコンテキストを一括取得（認証チェック + sid + credentials）
 * 全APIハンドラから呼び出す共通関数
 * 
 * @param {Object} postData - リクエストデータ（token, userId含む）
 * @return {Object|null} { sid, credentials, userId } or null（認証失敗）
 */
function getUserContext_(postData) {
  if (!validateToken_(postData.token, postData.userId)) {
    return null;
  }
  
  const cache = CacheService.getScriptCache();
  const sessionKey = 'session_' + postData.userId;
  const sessionData = cache.get(sessionKey);
  
  if (!sessionData) {
    // セッション切れ → api_keyシートから再取得
    return refreshUserContext_(postData.userId);
  }
  
  try {
    return JSON.parse(sessionData);
  } catch (e) {
    return refreshUserContext_(postData.userId);
  }
}

/**
 * api_keyシートからユーザーコンテキストを再取得
 */
function refreshUserContext_(userId) {
  try {
    const ss = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(AUTH_SHEET_NAME);
    if (!sheet) return null;
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const colIndex = {};
    headers.forEach((header, index) => { colIndex[header] = index; });
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][colIndex['id']] === userId) {
        const sheetRole = colIndex['role'] !== undefined ? (data[i][colIndex['role']] || '') : '';
        const resolvedRole = sheetRole || (userId === 'tokyoflower' ? 'admin' : 'user');
        const context = {
          userId: userId,
          sid: String(data[i][colIndex['sid']] || ''),
          role: resolvedRole,
          credentials: {
            serviceSecret: data[i][colIndex['serviceSecret']] || '',
            licenseKey: data[i][colIndex['licenseKey']] || '',
          },
        };
        // キャッシュに保存（6時間）
        saveUserContext_(userId, context);
        return context;
      }
    }
  } catch (e) {
    Logger.log('ユーザーコンテキスト再取得エラー: ' + e.message);
  }
  return null;
}

/**
 * ユーザーコンテキストをキャッシュに保存
 */
function saveUserContext_(userId, context) {
  const cache = CacheService.getScriptCache();
  const sessionKey = 'session_' + userId;
  cache.put(sessionKey, JSON.stringify(context), 21600); // 6時間
}

/**
 * 管理者権限チェック
 * @param {Object} ctx - getUserContext_() の返値
 * @return {boolean}
 */
function isAdminContext_(ctx) {
  return ctx && ctx.role === 'admin';
}

// ==================== 認証 ====================

/**
 * ログイン処理
 * [MT-3] sidをセッションに保存
 */
function handleLogin_(postData) {
  const response = { success: false, message: '', data: null };
  
  const userId = postData.userId || '';
  const password = postData.password || '';
  
  if (!userId || !password) {
    response.message = 'ユーザーIDとパスワードを入力してください';
    return createJsonResponse_(response);
  }
  
  // パスワードをBASE64エンコード
  const encodedPassword = 'BASE64:' + Utilities.base64Encode(password, Utilities.Charset.UTF_8);
  
  // 認証シートから照合
  const authResult = authenticateUser_(userId, encodedPassword);
  
  if (!authResult.success) {
    response.message = authResult.message;
    return createJsonResponse_(response);
  }
  
  // セッショントークン生成
  const token = generateSessionToken_(userId);
  
  // [MT-3] ユーザーコンテキスト（sid + credentials）をキャッシュに保存
  const context = {
    userId: userId,
    sid: String(authResult.user.sid || ''),
    role: authResult.user.role || 'user',
    credentials: {
      serviceSecret: authResult.user.serviceSecret || '',
      licenseKey: authResult.user.licenseKey || '',
    },
  };
  saveUserContext_(userId, context);
  
  // 認証成功
  response.success = true;
  response.message = 'ログイン成功';
  response.data = {
    userId: authResult.user.id,
    shopName: authResult.user.sname,
    sid: authResult.user.sid,
    email: authResult.user.email,
    expiry: authResult.user.expiry,
    token: token,
    role: authResult.user.role || 'user',   // ★ この1行を追加
  };
  
  return createJsonResponse_(response);
}

/**
 * ユーザー認証
 */
function authenticateUser_(userId, encodedPassword) {
  const ss = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(AUTH_SHEET_NAME);
  
  if (!sheet) {
    return { success: false, message: '認証シートが見つかりません' };
  }
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  // カラムインデックスを取得
  const colIndex = {};
  headers.forEach((header, index) => {
    colIndex[header] = index;
  });
  
  // ユーザーを検索
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    
    if (row[colIndex['id']] === userId) {
      // パスワード照合
      if (row[colIndex['pw']] !== encodedPassword) {
        return { success: false, message: 'パスワードが正しくありません' };
      }
      
      // 有効期限チェック
      const expiry = row[colIndex['expiry']];
      if (expiry) {
        const expiryDate = new Date(expiry);
        if (expiryDate < new Date()) {
          return { success: false, message: 'アカウントの有効期限が切れています' };
        }
      }
      
      // 認証成功
      // roleはシートのカラム→なければuserIdで判定
      const sheetRole = colIndex['role'] !== undefined ? (row[colIndex['role']] || '') : '';
      const resolvedRole = sheetRole || (userId === 'tokyoflower' ? 'admin' : 'user');

      return {
        success: true,
        user: {
          id: row[colIndex['id']],
          sname: row[colIndex['sname']] || '',
          email: row[colIndex['email']] || '',
          expiry: expiry,
          serviceSecret: row[colIndex['serviceSecret']] || '',
          licenseKey: row[colIndex['licenseKey']] || '',
          sid: row[colIndex['sid']] || '',
          role: resolvedRole,
        },
      };
    }
  }
  
  return { success: false, message: 'ユーザーが見つかりません' };
}

/**
 * セッショントークン生成（簡易版）
 */
function generateSessionToken_(userId) {
  const timestamp = new Date().getTime();
  const random = Math.random().toString(36).substring(2);
  const raw = userId + ':' + timestamp + ':' + random;
  return Utilities.base64Encode(raw, Utilities.Charset.UTF_8);
}

/**
 * トークン検証
 */
function validateToken_(token, userId) {
  if (!token || !userId) return false;
  
  try {
    const decoded = Utilities.newBlob(Utilities.base64Decode(token)).getDataAsString();
    const parts = decoded.split(':');
    
    if (parts[0] !== userId) return false;
    
    // 24時間以内かチェック
    const timestamp = parseInt(parts[1], 10);
    const now = new Date().getTime();
    const hoursDiff = (now - timestamp) / (1000 * 60 * 60);
    
    return hoursDiff < 24;
  } catch (e) {
    return false;
  }
}

// ==================== 設定取得・更新 ====================
function handleGetSettings_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const settings = loadSettings(ctx.sid);
    const items = loadTargetItems(ctx.sid);
    
    response.success = true;
    response.data = { 
      settings: settings,
      targetItemsCount: items.length
    };
    
  } catch (e) {
    response.message = '設定の取得に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

/**
 * 設定更新
 * [MT-3] sid対応
 */
function handleUpdateSettings_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const newSettings = postData.settings || {};
    
    // 安全な設定値のみ更新
    const allowedKeys = [
      'mode', 'dryRun', 'maxTitleZenkaku', 'keepNonEventBrackets',
      'shopMultiplierEnabled', 'shopMultiplierRate',
      'maxItemsPerRun', 'batchSize', 'apiSleepMs', 'logRetentionDays',
      'notifySlack', 'notifyEmail', 'slackWebhookUrl', 'notifyEmailAddress',
    ];
    
    const filteredSettings = {};
    for (const key of allowedKeys) {
      if (newSettings.hasOwnProperty(key)) {
        filteredSettings[key] = newSettings[key];
      }
    }
    
    saveSettings(filteredSettings, ctx.sid);
    
    response.success = true;
    response.message = '設定を更新しました';
    
  } catch (e) {
    response.message = '設定の更新に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

// ==================== イベント・ログ取得 ====================

/**
 * イベント一覧取得（全店舗共通）
 */
function handleGetEvents_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const events = loadAllEvents();

    response.success = true;
    response.data = {
      events: events.map(e => ({
        rowIndex: e.rowIndex,
        eventKey: e.eventKey,
        startDatetime: e.startDatetime.toISOString(),
        endDatetime: e.endDatetime.toISOString(),
        priority: e.priority,
        prefixLong: e.prefixLong,
        prefixMid: e.prefixMid,
        prefixShort: e.prefixShort,
        enabled: e.enabled,
      })),
    };

  } catch (e) {
    response.message = 'イベントの取得に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

/**
 * ログ取得
 * [修正4] 最新順に取得 + タイムスタンプのISO変換
 * [MT-3] sid対応
 */
function handleGetLogs_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const sheet = getOrCreateSheet_('LOG', ctx.sid);
    const data = sheet.getDataRange().getValues();
    const limit = postData.limit || 100;
    
    // [修正4] 最新（末尾）からlimit件を取得
    const logs = [];
    for (let i = data.length - 1; i >= 1 && logs.length < limit; i--) {
      const row = data[i];
      logs.push({
        // [修正4] タイムスタンプをISO文字列に変換
        timestamp: row[0] instanceof Date ? row[0].toISOString() : row[0],
        itemManageNumber: row[1] || '',
        oldTitle: row[2] || '',
        newTitle: row[3] || '',
        eventKey: row[4] || '',
        action: row[5] || '',
        status: row[6] || '',
        message: row[7] || '',
      });
    }
    
    // logsは既に新しい順なのでそのまま返す
    response.success = true;
    response.data = { logs: logs };
    
  } catch (e) {
    response.message = 'ログの取得に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

// ==================== 手動実行 ====================

/**
 * 手動実行（DryRunのみ許可）
 * [MT-3] 店舗指定で実行
 */
function handleRunManual_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    // [MT-3] 店舗指定でDryRun実行
    runForStore(ctx.sid, ctx.credentials, true);
    
    response.success = true;
    response.message = 'DryRun実行が完了しました。ログを確認してください。';
    
  } catch (e) {
    response.message = '実行に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

// ==================== 対象商品管理 ====================

/**
 * 対象商品一覧取得
 * [MT-3] sid対応
 */
function handleGetTargetItems_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const items = loadTargetItems(ctx.sid);
    
    response.success = true;
    response.data = {
      items: items.map(item => ({
        rowIndex: item.rowIndex,
        itemManageNumber: item.itemManageNumber,
        baseTitle: item.baseTitle,
        currentTitle: item.currentTitle,
        lastUpdated: item.lastUpdated ? new Date(item.lastUpdated).toISOString() : null,
        status: item.status,
      })),
    };
    
  } catch (e) {
    response.message = '対象商品の取得に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

/**
 * 対象商品追加
 * [MT-3] sid対応
 */
function handleAddTargetItem_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const itemManageNumber = postData.itemManageNumber;
    
    if (!itemManageNumber || itemManageNumber.trim() === '') {
      response.message = '商品管理番号を入力してください';
      return createJsonResponse_(response);
    }
    
    // 重複チェック
    const existingItems = loadTargetItems(ctx.sid);
    const isDuplicate = existingItems.some(
      item => item.itemManageNumber === itemManageNumber.trim()
    );
    
    if (isDuplicate) {
      response.message = 'この商品管理番号は既に登録されています';
      return createJsonResponse_(response);
    }
    
    // シートに追加
    const sheet = getOrCreateSheet_('TARGET_ITEMS', ctx.sid);
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, 5).setValues([
      [itemManageNumber.trim(), '', '', new Date(), '新規追加']
    ]);
    
    response.success = true;
    response.message = '商品を追加しました: ' + itemManageNumber;
    
  } catch (e) {
    response.message = '商品の追加に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

/**
 * 対象商品削除（商品管理番号で削除）
 * [MT-3] sid対応
 */
function handleDeleteTargetItem_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  try {
    const itemManageNumber = postData.itemManageNumber;
    
    if (!itemManageNumber) {
      response.message = '削除対象が指定されていません';
      return createJsonResponse_(response);
    }
    
    const sheet = getOrCreateSheet_('TARGET_ITEMS', ctx.sid);
    const data = sheet.getDataRange().getValues();
    
    // 商品管理番号で行を検索
    let targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(itemManageNumber)) {
        targetRow = i + 1; // 1-indexed
        break;
      }
    }
    
    if (targetRow === -1) {
      response.message = '商品が見つかりません（既に削除された可能性があります）';
      return createJsonResponse_(response);
    }
    
    sheet.deleteRow(targetRow);
    
    response.success = true;
    response.message = '商品を削除しました: ' + itemManageNumber;
    
  } catch (e) {
    response.message = '商品の削除に失敗しました: ' + e.message;
  }
  
  return createJsonResponse_(response);
}

/**
 * 対象商品一括追加（商品名自動取得付き）- 排他制御版
 * [MT-3] sid + credentials対応
 */
function handleBulkAddTargetItems_(postData) {
  const response = { success: false, message: '', data: null };
  
  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }
  
  // 排他制御: ロックを取得
  const lock = LockService.getScriptLock();
  
  try {
    // 30秒間ロックを取得（待機）
    if (!lock.tryLock(30000)) {
      response.message = '他のユーザーが操作中です。しばらく待ってから再度お試しください。';
      return createJsonResponse_(response);
    }
    
    const itemNumbers = postData.itemNumbers;
    
    if (!itemNumbers) {
      response.message = '商品管理番号を入力してください';
      return createJsonResponse_(response);
    }
    
    // 文字列の場合は配列に変換
    let numberList = Array.isArray(itemNumbers) 
      ? itemNumbers 
      : itemNumbers.split(/[\n,]/).map(s => s.trim()).filter(s => s);
    
    if (numberList.length === 0) {
      response.message = '有効な商品管理番号がありません';
      return createJsonResponse_(response);
    }
    
    // 既存の商品を取得（ロック内で取得することで整合性を保証）
    const existingItems = loadTargetItems(ctx.sid);
    const existingNumbers = new Set(existingItems.map(item => item.itemManageNumber));
    
    // 重複を除外
    const newNumbers = numberList.filter(num => !existingNumbers.has(num));
    const duplicateCount = numberList.length - newNumbers.length;
    
    if (newNumbers.length === 0) {
      response.message = '全ての商品管理番号が既に登録されています';
      return createJsonResponse_(response);
    }
    
    // 商品情報を楽天APIから取得
    const sheet = getOrCreateSheet_('TARGET_ITEMS', ctx.sid);
    const now = new Date();
    const rows = [];
    const errors = [];
    
    for (const manageNumber of newNumbers) {
      try {
        // [MT-3] 店舗別認証情報を渡して楽天APIから商品情報を取得
        const result = getItem(manageNumber, ctx.credentials);
        
        if (result.success && result.item) {
          const title = result.item.title || '';
          rows.push([manageNumber, title, title, now, '新規追加']);
        } else {
          // API取得失敗でも登録はする（商品名なし）
          rows.push([manageNumber, '', '', now, 'API取得失敗']);
          errors.push(manageNumber);
        }
        
        // API制限対策（1秒待機）
        Utilities.sleep(1000);
        
      } catch (e) {
        // エラーでも登録はする
        rows.push([manageNumber, '', '', now, 'エラー: ' + e.message]);
        errors.push(manageNumber);
      }
    }
    
    // シートに追加
    if (rows.length > 0) {
      const lastRow = sheet.getLastRow();
      sheet.getRange(lastRow + 1, 1, rows.length, 5).setValues(rows);
    }
    
    // 結果メッセージ作成
    let message = `${rows.length}件追加しました`;
    if (duplicateCount > 0) {
      message += `（${duplicateCount}件は重複のためスキップ）`;
    }
    if (errors.length > 0) {
      message += `（${errors.length}件は商品名取得失敗）`;
    }
    
    response.success = true;
    response.message = message;
    response.data = { 
      added: rows.length, 
      skipped: duplicateCount,
      errors: errors.length
    };
    
  } catch (e) {
    response.message = '商品の追加に失敗しました: ' + e.message;
  } finally {
    // ロックを解放
    lock.releaseLock();
  }

  return createJsonResponse_(response);
}

// ==================== イベント管理（管理者のみ） ====================

/**
 * 定期イベント自動生成（2ヶ月分）
 */
function handleGenerateEvents_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  if (!isAdminContext_(ctx)) {
    response.message = '管理者権限が必要です。';
    return createJsonResponse_(response);
  }

  try {
    generateRecurringEvents();

    response.success = true;
    response.message = 'イベントを自動生成しました（2ヶ月分）';

  } catch (e) {
    response.message = 'イベント生成に失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}

/**
 * マラソンイベント追加
 */
function handleAddMarathonEvent_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  if (!isAdminContext_(ctx)) {
    response.message = '管理者権限が必要です。';
    return createJsonResponse_(response);
  }

  try {
    const startDatetime = postData.startDatetime;
    const endDatetime = postData.endDatetime;

    if (!startDatetime || !endDatetime) {
      response.message = '開始日時と終了日時を入力してください';
      return createJsonResponse_(response);
    }

    addMarathonEvent(startDatetime, endDatetime);

    response.success = true;
    response.message = 'マラソンイベントを追加しました: ' + startDatetime + ' ～ ' + endDatetime;

  } catch (e) {
    response.message = 'マラソンイベントの追加に失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}

/**
 * 汎用イベント追加
 */
function handleAddEvent_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  if (!isAdminContext_(ctx)) {
    response.message = '管理者権限が必要です。';
    return createJsonResponse_(response);
  }

  try {
    const { eventKey, startDatetime, endDatetime, priority, prefixLong, prefixMid, prefixShort } = postData;

    if (!eventKey || !startDatetime || !endDatetime) {
      response.message = 'イベントキー・開始日時・終了日時は必須です';
      return createJsonResponse_(response);
    }

    if (!prefixLong) {
      response.message = 'Prefix（長）は必須です';
      return createJsonResponse_(response);
    }

    addEventRow({
      eventKey: eventKey,
      startDatetime: startDatetime,
      endDatetime: endDatetime,
      priority: priority || 4,
      prefixLong: prefixLong,
      prefixMid: prefixMid || prefixLong,
      prefixShort: prefixShort || prefixLong,
    });

    response.success = true;
    response.message = 'イベントを追加しました: ' + eventKey + ' ' + startDatetime + ' ～ ' + endDatetime;

  } catch (e) {
    response.message = 'イベントの追加に失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}

/**
 * イベント削除
 */
function handleDeleteEvent_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  if (!isAdminContext_(ctx)) {
    response.message = '管理者権限が必要です。';
    return createJsonResponse_(response);
  }

  try {
    const rowIndex = postData.rowIndex;

    if (!rowIndex || rowIndex < 2) {
      response.message = '削除対象が指定されていません';
      return createJsonResponse_(response);
    }

    deleteEventRow(rowIndex);

    response.success = true;
    response.message = 'イベントを削除しました';

  } catch (e) {
    response.message = 'イベントの削除に失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}

/**
 * イベント有効/無効切替
 */
function handleToggleEvent_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  if (!isAdminContext_(ctx)) {
    response.message = '管理者権限が必要です。';
    return createJsonResponse_(response);
  }

  try {
    const rowIndex = postData.rowIndex;

    if (!rowIndex || rowIndex < 2) {
      response.message = '対象が指定されていません';
      return createJsonResponse_(response);
    }

    const newEnabled = toggleEventRow(rowIndex);

    response.success = true;
    response.message = newEnabled ? 'イベントを有効にしました' : 'イベントを無効にしました';
    response.data = { enabled: newEnabled };

  } catch (e) {
    response.message = 'イベントの切替に失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}

// ==================== バックアップリセット ====================

/**
 * バックアップデータをリセット
 * ヘッダー以外を全削除し、次回実行時にバックアップ再作成＆手動変更検知リセット
 */
function handleResetBackups_(postData) {
  const response = { success: false, message: '', data: null };

  const ctx = getUserContext_(postData);
  if (!ctx) {
    response.message = '認証が必要です。再ログインしてください。';
    return createJsonResponse_(response);
  }

  try {
    const deletedCount = resetBackups(ctx.sid);

    response.success = true;
    response.message = 'バックアップをリセットしました（' + deletedCount + '件削除）';
    response.data = { deletedCount: deletedCount };

  } catch (e) {
    response.message = 'バックアップのリセットに失敗しました: ' + e.message;
  }

  return createJsonResponse_(response);
}
