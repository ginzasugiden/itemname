/**
 * Main.gs
 * メイン処理（オーケストレーション/トリガー/実行制御）
 * 
 * ===== 修正履歴 =====
 * [修正1] getAllActiveItems → getAllItems に修正
 * [修正2] item.itemUrl/item.itemName → item.manageNumber/item.title に修正（API 2.0対応）
 * [修正3] マルチテナント対応 - 認証情報をパラメータで受け渡し可能に
 * [修正5] 月次トリガー関数を追加
 * [MT-5] マルチテナント統合
 * [ME-1] 複数イベント同時適用対応
 *   - getCurrentEvent → getCurrentEvents（複数イベント取得）
 *   - processItems/processSingleItem → 複数prefix連結
 *   - ログにイベントキーをカンマ区切りで記録
 */

// ==================== [MT-5] メイン実行関数（全店舗ループ） ====================

/**
 * メイン処理（トリガーから呼び出し）
 * [MT-5] 全有効店舗をループして処理
 */
function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('別プロセスが実行中のためスキップ');
    return;
  }
  
  try {
    const startTime = new Date();
    Logger.log('=== 商品名更新処理開始（全店舗） ===');
    Logger.log('実行日時: ' + startTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
    
    const stores = getAllActiveStores();
    Logger.log('有効店舗数: ' + stores.length);
    
    if (stores.length === 0) {
      Logger.log('有効な店舗がありません');
      return;
    }
    
    for (const store of stores) {
      try {
        Logger.log('--- 店舗処理開始: ' + store.sname + ' (sid: ' + store.sid + ') ---');
        
        const credentials = {
          serviceSecret: store.serviceSecret,
          licenseKey: store.licenseKey,
        };
        
        runForStore(store.sid, credentials, false);
        
        Logger.log('--- 店舗処理完了: ' + store.sname + ' ---');
        
      } catch (e) {
        Logger.log('店舗処理エラー (' + store.sname + '): ' + e.message);
        Logger.log(e.stack);
        
        writeLog({
          timestamp: new Date(),
          action: LOG_ACTIONS.ERROR,
          status: LOG_STATUS.FAILED,
          message: '店舗処理エラー: ' + e.message,
        }, store.sid);
      }
    }
    
    Logger.log('=== 全店舗処理完了 ===');
    
  } catch (e) {
    Logger.log('致命的エラー: ' + e.message);
    Logger.log(e.stack);
  } finally {
    lock.releaseLock();
  }
}

// ==================== [MT-5] 単一店舗処理 ====================

/**
 * 単一店舗の処理を実行
 * [ME-1] 複数イベント同時適用対応
 * @param {string} sid - 楽天店舗ID
 * @param {Object} credentials - { serviceSecret, licenseKey }
 * @param {boolean} forceDryRun - true=強制DryRun（Web手動実行時）
 */
function runForStore(sid, credentials, forceDryRun, useNextEvent) {
  const startTime = new Date();

  // 設定読込（店舗別）
  const settings = loadSettings(sid);
  if (forceDryRun) settings.dryRun = true;

  Logger.log('モード: ' + settings.mode);
  Logger.log('dryRun: ' + settings.dryRun);

  // [ME-1] イベント読込と判定（複数イベント取得）
  const events = loadEvents();
  const now = new Date();
  const currentEvents = useNextEvent
    ? getNextEvents(now, events, settings)
    : getCurrentEvents(now, events, settings);
  
  if (currentEvents.length > 0) {
    Logger.log('適用イベント数: ' + currentEvents.length);
    for (const evt of currentEvents) {
      Logger.log('  - ' + evt.eventKey + ' (' + evt.prefixLong + ') priority=' + evt.priority);
    }
  } else {
    Logger.log('適用イベント: なし（prefix除去モード）');
  }
  
  // 対象商品取得（店舗別）
  const targetItems = fetchTargetItems(settings, sid, credentials);
  Logger.log('対象商品数: ' + targetItems.length);
  
  if (targetItems.length === 0) {
    Logger.log('処理対象がありません');
    return;
  }
  
  // バックアップ取得（店舗別）
  const backups = getAllBackups(sid);
  
  // [ME-1] 複数イベントを渡して処理実行
  const results = processItems(targetItems, currentEvents, settings, backups, sid, credentials);
  
  // 結果サマリー
  const summary = summarizeResults(results);
  Logger.log('処理件数: ' + summary.total);
  Logger.log('成功: ' + summary.success + ' / スキップ: ' + summary.skipped);
  Logger.log('エラー: ' + summary.error + ' / 手動変更検知: ' + summary.manualChange);
  
  // 通知 [ME-1] 複数イベント対応
  if (settings.notifySlack || settings.notifyEmail) {
    sendNotification(settings, currentEvents, summary);
  }
  
  // 古いログ削除（10%の確率）
  if (Math.random() < 0.1) {
    const deleted = cleanOldLogs(settings.logRetentionDays, sid);
    if (deleted > 0) {
      Logger.log('古いログ削除: ' + deleted + '件');
    }
  }
}

// ==================== 対象商品取得 ====================

function fetchTargetItems(settings, sid, credentials) {
  if (settings.mode === 'ALL_ACTIVE') {
    const items = getAllItems(settings.maxItemsPerRun, credentials);
    return items.map(item => ({
      itemManageNumber: item.manageNumber,
      currentTitle: item.title || '',
    }));
  } else {
    return loadTargetItems(sid);
  }
}

// ==================== 商品処理 ====================

/**
 * 商品を処理
 * [ME-1] currentEvents（配列）を受け取り、複数prefix対応
 * @param {Array} targetItems - 対象商品一覧
 * @param {Array} currentEvents - 適用中の全イベント
 * @param {Object} settings - 設定
 * @param {Object} backups - バックアップデータ
 * @param {string} sid - 店舗ID
 * @param {Object} credentials - 認証情報
 */
function processItems(targetItems, currentEvents, settings, backups, sid, credentials) {
  const results = [];
  const logsToWrite = [];
  const updateQueue = [];
  
  // [ME-1] 複数イベントのprefix候補を取得
  const multiPrefixCandidates = getMultiPrefixCandidates(currentEvents);
  
  // イベントキーをカンマ区切りで記録用
  const eventKeysStr = currentEvents.map(e => e.eventKey).join(',');
  
  for (const targetItem of targetItems) {
    try {
      const result = processSingleItem(
        targetItem, multiPrefixCandidates, currentEvents, eventKeysStr, settings, backups, sid, credentials
      );
      
      results.push(result);
      logsToWrite.push(result.log);
      
      if (result.needsUpdate && !settings.dryRun) {
        updateQueue.push({
          manageNumber: targetItem.itemManageNumber,
          newTitle: result.newTitle,
          rowIndex: targetItem.rowIndex,
        });
      }
      
      // TARGET_ITEMSシートを更新（店舗別）
      if (targetItem.rowIndex && result.baseTitle) {
        updateTargetItemRow(targetItem.rowIndex, {
          baseTitle: result.baseTitle,
          currentTitle: result.newTitle || targetItem.currentTitle,
          lastUpdated: new Date(),
          status: result.status,
        }, sid);
      }
      
    } catch (e) {
      results.push({
        itemManageNumber: targetItem.itemManageNumber,
        success: false,
        status: LOG_STATUS.FAILED,
        log: {
          timestamp: new Date(),
          itemManageNumber: targetItem.itemManageNumber,
          oldTitle: targetItem.currentTitle,
          action: LOG_ACTIONS.ERROR,
          status: LOG_STATUS.FAILED,
          message: e.message,
        },
      });
    }
  }
  
  // APIで一括更新（店舗別credentials）
  if (updateQueue.length > 0) {
    const updateResults = updateItemTitlesBatch(updateQueue, credentials);
    
    for (let i = 0; i < updateQueue.length; i++) {
      const updateResult = updateResults.results[i];
      const resultIndex = results.findIndex(
        r => r.itemManageNumber === updateQueue[i].manageNumber
      );
      
      if (resultIndex >= 0) {
        if (updateResult.success) {
          results[resultIndex].status = LOG_STATUS.SUCCESS;
          logsToWrite[resultIndex].status = LOG_STATUS.SUCCESS;
          logsToWrite[resultIndex].message = 'API更新成功';
        } else {
          results[resultIndex].status = LOG_STATUS.FAILED;
          logsToWrite[resultIndex].status = LOG_STATUS.FAILED;
          logsToWrite[resultIndex].message = 'APIエラー: ' + (updateResult.error?.message || 'Unknown');
        }
      }
    }
  }
  
  // ログ一括書き込み（店舗別）
  writeLogs(logsToWrite, sid);
  
  return results;
}

/**
 * 単一商品を処理
 * [ME-1] 複数prefix対応
 */
function processSingleItem(targetItem, multiPrefixCandidates, currentEvents, eventKeysStr, settings, backups, sid, credentials) {
  // 商品情報取得（店舗別credentials）
  let currentTitle = '';
  {
    const itemResult = getItem(targetItem.itemManageNumber, credentials);
    if (!itemResult.success) {
      throw new Error('商品取得失敗: ' + (itemResult.error?.message || 'Unknown'));
    }
    currentTitle = itemResult.item.title || '';
    Utilities.sleep(settings.apiSleepMs);
  }
  
  // ベース名を取得
  const baseTitle = stripEventPrefixes(currentTitle);
  
  // バックアップ確認と手動変更検知
  const backup = backups[targetItem.itemManageNumber];
  if (backup && detectManualChange(currentTitle, backup.originalTitle)) {
    return {
      itemManageNumber: targetItem.itemManageNumber,
      needsUpdate: false,
      baseTitle: baseTitle,
      status: LOG_STATUS.MANUAL_CHANGE,
      log: {
        timestamp: new Date(),
        itemManageNumber: targetItem.itemManageNumber,
        oldTitle: currentTitle,
        eventKey: eventKeysStr,
        action: LOG_ACTIONS.SKIP,
        status: LOG_STATUS.MANUAL_CHANGE,
        message: '手動変更が検知されたためスキップ',
      },
    };
  }
  
  // バックアップ保存（店舗別）
  if (!backup) {
    saveBackup(targetItem.itemManageNumber, baseTitle, sid);
  }
  
  // [ME-1] 複数prefix対応の商品名生成
  const buildResult = buildTitleMulti(
    baseTitle, multiPrefixCandidates, settings.maxTitleZenkaku, settings.keepNonEventBrackets
  );
  const newTitle = buildResult.title;
  
  // 変更が必要かチェック
  if (newTitle === currentTitle) {
    return {
      itemManageNumber: targetItem.itemManageNumber,
      needsUpdate: false,
      baseTitle: baseTitle,
      newTitle: newTitle,
      status: LOG_STATUS.SKIPPED,
      log: {
        timestamp: new Date(),
        itemManageNumber: targetItem.itemManageNumber,
        oldTitle: currentTitle,
        newTitle: newTitle,
        eventKey: eventKeysStr,
        action: LOG_ACTIONS.SKIP,
        status: LOG_STATUS.SKIPPED,
        message: '変更なし',
      },
    };
  }
  
  // 更新が必要
  const action = multiPrefixCandidates.length > 0 ? LOG_ACTIONS.INSERT : LOG_ACTIONS.REMOVE;
  const status = settings.dryRun ? LOG_STATUS.DRY_RUN : LOG_STATUS.SUCCESS;
  
  // [ME-1] 適用されたprefixの情報をメッセージに含める
  const prefixInfo = buildResult.prefixes.length > 0
    ? buildResult.prefixes.map(p => p.prefix).join('')
    : '(prefix除去)';
  
  return {
    itemManageNumber: targetItem.itemManageNumber,
    needsUpdate: true,
    baseTitle: baseTitle,
    newTitle: newTitle,
    status: status,
    log: {
      timestamp: new Date(),
      itemManageNumber: targetItem.itemManageNumber,
      oldTitle: currentTitle,
      newTitle: newTitle,
      eventKey: eventKeysStr,
      action: action,
      status: status,
      message: settings.dryRun
        ? 'DryRun（実際の更新なし）prefix: ' + prefixInfo
        : '更新予定 prefix: ' + prefixInfo,
    },
  };
}

// ==================== 結果サマリー ====================

function summarizeResults(results) {
  return {
    total: results.length,
    success: results.filter(r => r.status === LOG_STATUS.SUCCESS).length,
    skipped: results.filter(r => r.status === LOG_STATUS.SKIPPED).length,
    error: results.filter(r => r.status === LOG_STATUS.FAILED).length,
    manualChange: results.filter(r => r.status === LOG_STATUS.MANUAL_CHANGE).length,
    dryRun: results.filter(r => r.status === LOG_STATUS.DRY_RUN).length,
  };
}

// ==================== 通知 ====================

/**
 * [ME-1] 複数イベント対応の通知
 * @param {Object} settings - 設定
 * @param {Array} currentEvents - 適用中の全イベント
 * @param {Object} summary - 結果サマリー
 */
function sendNotification(settings, currentEvents, summary) {
  const eventNames = currentEvents.length > 0
    ? currentEvents.map(e => e.prefixLong).join(' + ')
    : 'なし';
  
  const message = `
【楽天商品名自動更新】
実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
適用イベント: ${eventNames}
処理件数: ${summary.total}
- 成功: ${summary.success}
- スキップ: ${summary.skipped}
- エラー: ${summary.error}
- 手動変更検知: ${summary.manualChange}
${settings.dryRun ? '※ DryRunモード（実際の更新なし）' : ''}
`.trim();
  
  if (settings.notifySlack && settings.slackWebhookUrl) {
    try {
      UrlFetchApp.fetch(settings.slackWebhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: message }),
      });
    } catch (e) {
      Logger.log('Slack通知エラー: ' + e.message);
    }
  }
  
  if (settings.notifyEmail && settings.notifyEmailAddress) {
    try {
      GmailApp.sendEmail(
        settings.notifyEmailAddress,
        '【楽天商品名更新】' + eventNames,
        message
      );
    } catch (e) {
      Logger.log('メール通知エラー: ' + e.message);
    }
  }
}

// ==================== トリガー管理 ====================

function setupTrigger15min() {
  removeAllTriggers();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(15).create();
  Logger.log('15分おきのトリガーを設定しました');
}

function setupEventTriggers() {
  removeAllTriggers();
  
  ScriptApp.newTrigger('run').timeBased().everyHours(1).create();
  
  const triggerTimes = [
    { hour: 0, minute: 1 },
    { hour: 20, minute: 1 },
    { hour: 2, minute: 1 },
  ];
  
  for (const time of triggerTimes) {
    ScriptApp.newTrigger('run')
      .timeBased()
      .atHour(time.hour)
      .nearMinute(time.minute)
      .everyDays(1)
      .create();
  }
  
  Logger.log('イベント切替トリガーを設定しました');
}

function removeAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  Logger.log('既存のトリガーを削除しました');
}

function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('現在のトリガー数: ' + triggers.length);
  for (const trigger of triggers) {
    Logger.log('- ' + trigger.getHandlerFunction() + ': ' + trigger.getTriggerSource());
  }
}

// ==================== 月次イベント自動生成トリガー ====================

function setupMonthlyEventTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'generateRecurringEvents') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  
  ScriptApp.newTrigger('generateRecurringEvents')
    .timeBased()
    .onMonthDay(26)
    .atHour(9)
    .create();
  
  Logger.log('毎月26日 9:00 にイベント自動生成トリガーを設定しました');
}

function removeEventGenerationTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'generateRecurringEvents') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }
  
  Logger.log('イベント生成トリガーを削除しました: ' + removed + '件');
}

// ==================== 初期化・テスト ====================

function setup(sid) {
  Logger.log('=== 初期セットアップ開始 ===');
  
  initializeAllSheets(sid);
  
  Logger.log('=== セットアップ完了 ===');
  if (sid) {
    Logger.log('店舗別シート作成済み: S_' + sid + ', T_' + sid + ', L_' + sid + ', B_' + sid);
  }
  Logger.log('次のステップ:');
  Logger.log('1. 設定シートの設定を確認');
  Logger.log('2. EVENTSシートにイベントを登録');
  Logger.log('3. 対象商品シートに商品を登録');
  Logger.log('4. testDryRun()でテスト実行');
}

function setupGinza() {
  setup('240364');
}

/**
 * DryRunテスト
 * [ME-1] 複数イベント対応のログ出力
 */
function testDryRun() {
  Logger.log('=== DryRunテスト ===');
  
  const stores = getAllActiveStores();
  
  if (stores.length === 0) {
    Logger.log('店舗情報なし。レガシーモードで実行');
    const settings = loadSettings();
    settings.dryRun = true;
    return;
  }
  
  for (const store of stores) {
    Logger.log('--- DryRun: ' + store.sname + ' (sid: ' + store.sid + ') ---');
    const credentials = {
      serviceSecret: store.serviceSecret,
      licenseKey: store.licenseKey,
    };
    runForStore(store.sid, credentials, true);
  }
  
  Logger.log('\n === DryRun完了 ===');
  Logger.log('LOGシートとTARGET_ITEMSシートを確認してください');
  Logger.log('楽天RMSの商品名が変更されていないことを確認してください');
}

/**
 * 今日のイベントを確認
 * [ME-1] 複数イベント表示対応
 */
function checkTodayEvent() {
  const events = loadEvents();
  const now = new Date();
  
  Logger.log('現在日時: ' + now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  
  const settings = loadSettings();
  const currentEvents = getCurrentEvents(now, events, settings);
  
  if (currentEvents.length > 0) {
    Logger.log('\n=== 現在適用中のイベント (' + currentEvents.length + '件) ===');
    for (const evt of currentEvents) {
      Logger.log('  ' + evt.eventKey + ': ' + evt.prefixLong + ' (priority=' + evt.priority + ')');
    }
    Logger.log('連結prefix: ' + currentEvents.map(e => e.prefixLong).join(''));
  } else {
    Logger.log('適用イベント: なし');
  }
  
  Logger.log('\n=== 今後のイベント ===');
  const futureEvents = events
    .filter(e => e.startDatetime > now)
    .sort((a, b) => a.startDatetime - b.startDatetime)
    .slice(0, 10);
  
  for (const event of futureEvents) {
    Logger.log(
      event.eventKey + ': ' +
      event.startDatetime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) +
      ' ～ ' +
      event.endDatetime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    );
  }
}