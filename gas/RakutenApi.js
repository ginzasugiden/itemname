/**
 * RakutenApi.gs
 * 楽天RMS ItemAPI 2.0 連携（認証/リクエスト/リトライ/バッチ処理）
 * 
 * ※ このファイルは変更なし（既に修正3でcredentialsパラメータ対応済み）
 * 
 * ===== 修正履歴 =====
 * [修正2] レスポンスフィールド名をAPI 2.0仕様に統一（title, manageNumber）
 * [修正3] マルチテナント対応 - 店舗別の認証情報を受け取れるように変更
 *         - getApiCredentials_() にオプション引数 overrideCredentials を追加
 *         - apiRequest_() にオプション引数 credentials を追加
 *         - 各公開関数に credentials パラメータを追加
 * 
 * API仕様:
 * - 検索: GET  /es/2.0/items/search?manageNumber=xxx
 * - 取得: GET  /es/2.0/items/manage-numbers/{manageNumber}
 * - 更新: PATCH /es/2.0/items/manage-numbers/{manageNumber}
 */

// ==================== 認証 ====================

/**
 * API認証情報を取得
 * [修正3] overrideCredentials が渡された場合はそちらを優先使用
 * [修正6] BASE64:プレフィックス付き値のデコード対応
 */
function getApiCredentials_(overrideCredentials) {
  let serviceSecret, licenseKey;

  // マルチテナント: 店舗別認証情報が渡された場合はそちらを使用
  if (overrideCredentials && overrideCredentials.serviceSecret && overrideCredentials.licenseKey) {
    serviceSecret = overrideCredentials.serviceSecret;
    licenseKey = overrideCredentials.licenseKey;
  } else {
    // フォールバック: ScriptPropertiesから取得
    const props = PropertiesService.getScriptProperties();
    serviceSecret = props.getProperty('RAKUTEN_SERVICE_SECRET');
    licenseKey = props.getProperty('RAKUTEN_LICENSE_KEY');

    if (!serviceSecret || !licenseKey) {
      throw new Error('API認証情報が設定されていません。ScriptPropertiesを確認してください。');
    }
  }

  // [修正6] BASE64:プレフィックス付きの場合はデコード
  if (serviceSecret.startsWith('BASE64:')) {
    serviceSecret = Utilities.newBlob(Utilities.base64Decode(serviceSecret.substring(7))).getDataAsString();
  }
  if (licenseKey.startsWith('BASE64:')) {
    licenseKey = Utilities.newBlob(Utilities.base64Decode(licenseKey.substring(7))).getDataAsString();
  }

  return { serviceSecret, licenseKey };
}

/**
 * Authorization ヘッダーを生成
 * [修正3] credentials パラメータ追加
 */
function buildAuthHeader_(credentials) {
  const creds = getApiCredentials_(credentials);
  const authString = creds.serviceSecret + ':' + creds.licenseKey;
  const base64 = Utilities.base64Encode(authString, Utilities.Charset.UTF_8);
  return 'ESA ' + base64;
}

// ==================== HTTPリクエスト ====================

/**
 * APIリクエストを実行（リトライ付き）
 * [修正3] credentials パラメータ追加（5番目の引数）
 */
function apiRequest_(method, endpoint, queryParams, bodyPayload, retryCount, credentials) {
  if (retryCount === undefined) retryCount = 0;
  
  const baseUrl = 'https://api.rms.rakuten.co.jp/es/2.0';
  let url = baseUrl + endpoint;
  
  // クエリパラメータを追加
  if (queryParams && Object.keys(queryParams).length > 0) {
    const params = [];
    for (const key in queryParams) {
      if (queryParams[key] !== undefined && queryParams[key] !== null) {
        params.push(encodeURIComponent(key) + '=' + encodeURIComponent(queryParams[key]));
      }
    }
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
  }
  
  const options = {
    method: method,
    headers: {
      'Authorization': buildAuthHeader_(credentials),  // [修正3]
    },
    muteHttpExceptions: true,
  };
  
  // POSTまたはPATCHの場合はボディを追加
  if (bodyPayload && (method === 'post' || method === 'patch')) {
    options.contentType = 'application/json; charset=UTF-8';
    options.payload = JSON.stringify(bodyPayload);
  }
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    // 成功
    if (statusCode >= 200 && statusCode < 300) {
      try {
        return {
          success: true,
          data: responseText ? JSON.parse(responseText) : {},
          statusCode: statusCode,
        };
      } catch (e) {
        return {
          success: true,
          data: responseText,
          statusCode: statusCode,
        };
      }
    }
    
    // リトライ対象のエラー（429 Too Many Requests, 5xx Server Error）
    if ((statusCode === 429 || statusCode >= 500) && retryCount < 3) {
      const delay = 2000 * Math.pow(2, retryCount); // 指数バックオフ
      Logger.log('APIリトライ (' + (retryCount + 1) + '/3): ' + delay + 'ms後');
      Utilities.sleep(delay);
      return apiRequest_(method, endpoint, queryParams, bodyPayload, retryCount + 1, credentials);
    }
    
    // エラー
    return {
      success: false,
      error: parseApiError_(responseText, statusCode),
      statusCode: statusCode,
    };
    
  } catch (e) {
    // ネットワークエラー等
    if (retryCount < 3) {
      const delay = 2000 * Math.pow(2, retryCount);
      Logger.log('ネットワークエラー、リトライ (' + (retryCount + 1) + '/3): ' + delay + 'ms後');
      Utilities.sleep(delay);
      return apiRequest_(method, endpoint, queryParams, bodyPayload, retryCount + 1, credentials);
    }
    
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: e.message,
      },
      statusCode: 0,
    };
  }
}

/**
 * APIエラーレスポンスをパース
 */
function parseApiError_(responseText, statusCode) {
  try {
    const data = JSON.parse(responseText);
    if (data.errors && data.errors.length > 0) {
      return {
        code: data.errors[0].code || 'UNKNOWN',
        message: data.errors[0].message || 'Unknown error',
      };
    }
    return { code: 'HTTP_' + statusCode, message: responseText.substring(0, 200) };
  } catch (e) {
    return { code: 'HTTP_' + statusCode, message: responseText.substring(0, 200) };
  }
}

// ==================== 商品取得 ====================

/**
 * 商品情報を取得（単一）- manage-numbers エンドポイント使用
 * GET /es/2.0/items/manage-numbers/{manageNumber}
 * [修正3] credentials パラメータ追加
 */
function getItem(manageNumber, credentials) {
  const endpoint = '/items/manage-numbers/' + encodeURIComponent(manageNumber);
  const result = apiRequest_('get', endpoint, null, null, 0, credentials);
  
  if (result.success && result.data) {
    return {
      success: true,
      item: result.data,
    };
  }
  
  return {
    success: false,
    error: result.error || { code: 'NO_DATA', message: '商品が見つかりません' },
  };
}

/**
 * 商品情報を一括取得
 * [修正3] credentials パラメータ追加
 */
function getItems(manageNumbers, credentials) {
  const results = [];
  
  for (const manageNum of manageNumbers) {
    const result = getItem(manageNum, credentials);
    results.push({
      manageNumber: manageNum,
      success: result.success,
      item: result.item,
      error: result.error,
    });
    
    // API制限対策
    Utilities.sleep(1000);
  }
  
  return results;
}

/**
 * 販売中の商品を検索（ALL_ACTIVEモード用）
 * GET /es/2.0/items/search
 * [修正3] credentials パラメータ追加
 */
function searchItems(queryParams, credentials) {
  const result = apiRequest_('get', '/items/search', queryParams, null, 0, credentials);
  
  if (result.success && result.data) {
    return {
      success: true,
      items: result.data.results || [],
      numFound: result.data.numFound || 0,
      nextCursorMark: result.data.nextCursorMark || null,
    };
  }
  
  return {
    success: false,
    error: result.error,
    items: [],
    numFound: 0,
    nextCursorMark: null,
  };
}

/**
 * 全商品を取得（ページング処理）
 * [修正3] credentials パラメータ追加
 */
function getAllItems(maxItems, credentials) {
  const allItems = [];
  let cursorMark = '*';
  const hits = 30;
  
  while (allItems.length < maxItems) {
    const params = {
      cursorMark: cursorMark,
      hits: hits,
      hideItem: false, // 公開中のみ
    };
    
    const result = searchItems(params, credentials);
    
    if (!result.success) {
      Logger.log('商品検索エラー: ' + JSON.stringify(result.error));
      break;
    }
    
    for (const itemWrapper of result.items) {
      if (allItems.length >= maxItems) break;
      // results配列の各要素は {item: {...}} の形式
      const item = itemWrapper.item || itemWrapper;
      allItems.push(item);
    }
    
    // 次ページがなければ終了
    if (!result.nextCursorMark || result.nextCursorMark === cursorMark) break;
    cursorMark = result.nextCursorMark;
    
    Utilities.sleep(1000);
  }
  
  return allItems;
}

// ==================== 商品更新 ====================

/**
 * 商品を更新（単一）
 * PATCH /es/2.0/items/manage-numbers/{manageNumber}
 * [修正3] credentials パラメータ追加
 */
function updateItem(manageNumber, updateData, credentials) {
  const endpoint = '/items/manage-numbers/' + encodeURIComponent(manageNumber);
  const result = apiRequest_('patch', endpoint, null, updateData, 0, credentials);
  
  return {
    success: result.success,
    error: result.error,
    statusCode: result.statusCode,
  };
}

/**
 * 商品名を更新（単一）
 * [修正3] credentials パラメータ追加
 */
function updateItemTitle(manageNumber, newTitle, credentials) {
  return updateItem(manageNumber, { title: newTitle }, credentials);
}

/**
 * 商品名を一括更新
 * [修正3] credentials パラメータ追加
 */
function updateItemTitlesBatch(items, credentials) {
  // items: [{ manageNumber, newTitle }, ...]
  
  if (items.length === 0) return { success: true, results: [] };
  
  const results = [];
  
  for (const item of items) {
    const result = updateItemTitle(item.manageNumber, item.newTitle, credentials);
    
    results.push({
      manageNumber: item.manageNumber,
      success: result.success,
      error: result.error,
    });
    
    // API制限対策（1秒待機）
    Utilities.sleep(1000);
  }
  
  return {
    success: results.every(r => r.success),
    results: results,
  };
}

// ==================== テスト用関数 ====================

/**
 * API接続テスト
 */
function testApiConnection() {
  Logger.log('=== API接続テスト ===');
  
  try {
    // 認証情報確認
    const creds = getApiCredentials_();
    Logger.log('認証情報: OK (serviceSecret: ' + creds.serviceSecret.substring(0, 10) + '...)');
    
    // 検索APIテスト
    Logger.log('検索APIテスト中...');
    const searchResult = searchItems({ hits: 1 });
    
    if (searchResult.success) {
      Logger.log('検索API: 成功');
      Logger.log('総商品数: ' + searchResult.numFound);
      if (searchResult.items.length > 0) {
        const item = searchResult.items[0].item || searchResult.items[0];
        Logger.log('サンプル商品: ' + (item.title || item.manageNumber || 'N/A'));
      }
    } else {
      Logger.log('検索API: 失敗 - ' + JSON.stringify(searchResult.error));
    }
    
  } catch (e) {
    Logger.log('エラー: ' + e.message);
  }
}

/**
 * 商品取得テスト
 */
function testGetItem() {
  // TARGET_ITEMSシートから最初の商品を取得してテスト
  const targetItems = loadTargetItems();
  
  if (targetItems.length === 0) {
    Logger.log('TARGET_ITEMSシートに商品が登録されていません');
    return;
  }
  
  const testManageNumber = targetItems[0].itemManageNumber;
  Logger.log('=== 商品取得テスト ===');
  Logger.log('商品管理番号: ' + testManageNumber);
  
  const result = getItem(testManageNumber);
  
  if (result.success) {
    Logger.log('取得成功！');
    Logger.log('商品名(title): ' + (result.item.title || 'N/A'));
    Logger.log('商品タイプ: ' + (result.item.itemType || 'N/A'));
    Logger.log('ジャンルID: ' + (result.item.genreId || 'N/A'));
    
    // 文字数確認
    if (result.item.title) {
      Logger.log('商品名文字数(全角換算): ' + calcZenkakuLength(result.item.title));
    }
  } else {
    Logger.log('取得失敗: ' + JSON.stringify(result.error));
  }
}

/**
 * 商品更新テスト（DryRun）
 */
function testUpdateItemDryRun() {
  const targetItems = loadTargetItems();
  
  if (targetItems.length === 0) {
    Logger.log('TARGET_ITEMSシートに商品が登録されていません');
    return;
  }
  
  const testManageNumber = targetItems[0].itemManageNumber;
  Logger.log('=== 商品更新テスト (DryRun) ===');
  Logger.log('商品管理番号: ' + testManageNumber);
  
  // まず現在の商品名を取得
  const getResult = getItem(testManageNumber);
  if (!getResult.success) {
    Logger.log('商品取得失敗: ' + JSON.stringify(getResult.error));
    return;
  }
  
  const currentTitle = getResult.item.title;
  Logger.log('現在の商品名: ' + currentTitle);
  
  // テスト用の新しい商品名を生成（先頭に【テスト】を追加）
  const testTitle = '【テスト】' + stripEventPrefixes(currentTitle);
  Logger.log('テスト商品名: ' + testTitle);
  
  // 実際には更新しない
  Logger.log('※ DryRunのため実際の更新は行いません');
  Logger.log('※ 本番更新をテストする場合は testUpdateItemReal() を使用してください');
}

/**
 * デバッグ: 詳細API接続テスト
 */
function debugApiConnection() {
  Logger.log('=== API接続詳細テスト ===');
  
  // 認証情報確認
  const props = PropertiesService.getScriptProperties();
  const serviceSecret = props.getProperty('RAKUTEN_SERVICE_SECRET');
  const licenseKey = props.getProperty('RAKUTEN_LICENSE_KEY');
  
  Logger.log('serviceSecret: ' + (serviceSecret ? serviceSecret.substring(0, 10) + '...' : '未設定'));
  Logger.log('licenseKey: ' + (licenseKey ? licenseKey.substring(0, 10) + '...' : '未設定'));
  
  if (!serviceSecret || !licenseKey) {
    Logger.log('認証情報が設定されていません');
    return;
  }
  
  // 認証ヘッダー生成
  const authString = serviceSecret + ':' + licenseKey;
  const base64Auth = Utilities.base64Encode(authString, Utilities.Charset.UTF_8);
  Logger.log('Authorization: ESA ' + base64Auth.substring(0, 20) + '...');
  
  // 検索APIテスト (GET)
  const url = 'https://api.rms.rakuten.co.jp/es/2.0/items/search?hits=1';
  
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'ESA ' + base64Auth,
    },
    muteHttpExceptions: true,
  };
  
  try {
    Logger.log('リクエストURL: ' + url);
    Logger.log('メソッド: GET');
    
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    Logger.log('ステータスコード: ' + statusCode);
    Logger.log('レスポンス: ' + responseText.substring(0, 1000));
    
    if (statusCode === 200) {
      const data = JSON.parse(responseText);
      Logger.log('成功！ 商品数: ' + (data.numFound || 0));
    }
  } catch (e) {
    Logger.log('リクエスト例外: ' + e.message);
  }
}

/**
 * デバッグ: 商品取得テスト
 */
function debugGetItem() {
  const settings = loadSettings();
  const targetItems = loadTargetItems();
  
  Logger.log('=== デバッグ: 商品取得テスト ===');
  Logger.log('対象商品数: ' + targetItems.length);
  
  if (targetItems.length === 0) {
    Logger.log('TARGET_ITEMSシートに商品が登録されていません');
    return;
  }
  
  const item = targetItems[0];
  Logger.log('商品管理番号: ' + item.itemManageNumber);
  
  // API呼び出しテスト
  try {
    const result = getItem(item.itemManageNumber);
    Logger.log('API結果: ' + JSON.stringify(result).substring(0, 1000));
    
    if (result.success) {
      Logger.log('商品名: ' + result.item.title);
    } else {
      Logger.log('エラー: ' + JSON.stringify(result.error));
    }
  } catch (e) {
    Logger.log('例外: ' + e.message);
    Logger.log('スタック: ' + e.stack);
  }
}
