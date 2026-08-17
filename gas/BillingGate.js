/**
 * BillingGate.gs
 * 課金ゲート連携（account/gas の handleVerifyMember 呼び出し）
 *
 * Phase 1 パイロット実装。
 * 対象サービス名は 'itemname' 固定（account側 api_key シートの services 列で判定される）。
 *
 * ===== 設計メモ =====
 * - 呼び出し先URL・サービス名はハードコードせず ScriptProperties から取得する
 *   （ACCOUNT_API_URL: account/gas のWebApp exec URL, 未設定時はゲートを素通りさせる＝Phase1のフェイルセーフ）
 * - ネットワークエラー・想定外レスポンス時は「フェイルオープン（処理続行）+ 管理者通知」とする。
 *   理由: 本番の定期実行（商品名更新）が外部API疎通不良だけで完全停止すると、
 *   セール中の商品名が更新されない等の実害の方が「一時的に無課金ユーザーを通してしまう」リスクより大きいと判断。
 *   Phase 2以降、account側APIの安定稼働が確認できた段階でフェイルクローズへの切替を検討する（FAIL_CLOSED_ON_ERROR で切替可能）。
 * - RESTORE（復元）系処理はあえてゲート対象外とする。
 *   理由: 復元はイベントprefixを元に戻すだけの後始末処理であり、これをブロックすると
 *   非課金化した店舗の商品名がプロモーション表記のまま放置される方が業務上望ましくない。
 */

// ==================== 設定 ====================

var BILLING_GATE_SERVICE_NAME = 'itemname';

// true にするとAPIエラー時に実行をブロックする（Phase1は false = フェイルオープン）
var BILLING_GATE_FAIL_CLOSED_ON_ERROR = false;

/**
 * account/gas の WebApp exec URL を取得
 * ScriptProperties の ACCOUNT_API_URL を使用。未設定時は null を返す（呼び出し側でゲートスキップ扱い）。
 */
function getAccountApiUrl_() {
  var url = PropertiesService.getScriptProperties().getProperty('ACCOUNT_API_URL');
  return url || null;
}

/**
 * 課金ゲート通知用の管理者宛先を取得（GSD側の管理者。店舗自身の通知先とは別）
 */
function getBillingAdminEmail_() {
  return PropertiesService.getScriptProperties().getProperty('BILLING_ADMIN_EMAIL') || null;
}

// ==================== 本体 ====================

/**
 * account/gas の handleVerifyMember を呼び出し、課金・契約状態を確認する。
 *
 * @param {string} loginId - api_key シートの id 列の値（store.id。store.sid＝楽天店舗IDとは別物なので注意）
 * @param {string} service - サービスコード（既定: 'itemname'）
 * @return {{ok: boolean, reason: string, message: string, raw: Object|null, transportError: boolean}}
 *   ok=true  : 契約・支払い状況ともに正常。処理続行してよい。
 *   ok=false : 明示的に拒否された（PAYMENT_REQUIRED / NOT_SUBSCRIBED / LICENSE_EXPIRED / INVALID_CREDENTIALS）。
 *   transportError=true: account APIへの疎通自体に失敗（フェイルオープン/クローズの判断は呼び出し側 checkBillingGate_ が行う）。
 */
function verifyBilling_(loginId, service) {
  service = service || BILLING_GATE_SERVICE_NAME;

  var apiUrl = getAccountApiUrl_();
  if (!apiUrl) {
    // URL未設定 = 課金ゲート未セットアップ状態。Phase1移行期はブロックせず素通りさせる。
    return { ok: true, reason: 'GATE_NOT_CONFIGURED', message: 'ACCOUNT_API_URL 未設定のためゲートをスキップしました', raw: null, transportError: false };
  }

  if (!loginId) {
    return { ok: false, reason: 'NO_LOGIN_ID', message: 'store.id が空のため検証できません', raw: null, transportError: false };
  }

  var payload = {
    endpoint: '/member/verify',
    data: { id: loginId, service: service },
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response;
  try {
    response = UrlFetchApp.fetch(apiUrl, options);
  } catch (e) {
    return { ok: false, reason: 'TRANSPORT_ERROR', message: 'account API 呼び出し失敗: ' + e.message, raw: null, transportError: true };
  }

  var code = response.getResponseCode();
  var text = response.getContentText();

  var body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'MALFORMED_RESPONSE', message: 'account API レスポンス解析失敗 (HTTP ' + code + '): ' + text.substring(0, 200), raw: null, transportError: true };
  }

  if (code !== 200) {
    return { ok: false, reason: 'HTTP_' + code, message: 'account API 非200応答: ' + JSON.stringify(body), raw: body, transportError: true };
  }

  if (body.status === 'success' && body.valid === true) {
    return { ok: true, reason: 'OK', message: '検証成功', raw: body, transportError: false };
  }

  // 明示的な拒否レスポンス（PAYMENT_REQUIRED / NOT_SUBSCRIBED / LICENSE_EXPIRED / INVALID_CREDENTIALS 等）
  return {
    ok: false,
    reason: body.error_code || 'UNKNOWN_ERROR',
    message: body.message || '不明なエラー',
    raw: body,
    transportError: false,
  };
}

/**
 * 店舗単位の課金ゲートチェック。
 * runForStore() の冒頭から呼び出される想定。
 *
 * @param {Object} store - { sid, id, sname, ... }（run() の getAllActiveStores() 由来オブジェクト。id が account側login id）
 * @return {{allow: boolean, result: Object}} allow=false の場合は runForStore を即 return すること
 */
function checkBillingGate_(store) {
  var displayName = store.sname || store.sid; // runForStore() 経由の呼び出しは sname を持たないため sid で代替
  var result = verifyBilling_(store.id, BILLING_GATE_SERVICE_NAME);

  if (result.ok) {
    return { allow: true, result: result };
  }

  // 疎通エラー（transportError）はフェイルオープン設定に従う
  if (result.transportError && !BILLING_GATE_FAIL_CLOSED_ON_ERROR) {
    Logger.log('[BillingGate] 疎通エラーのためフェイルオープン（処理続行）: ' + displayName + ' (' + result.reason + ': ' + result.message + ')');
    notifyBillingIssue_(store, result, /*blocked=*/false);
    return { allow: true, result: result };
  }

  // 明示的拒否 or フェイルクローズ設定時の疎通エラー → ブロック
  Logger.log('[BillingGate] 処理をスキップします: ' + displayName + ' (sid: ' + store.sid + ') reason=' + result.reason + ' message=' + result.message);
  notifyBillingIssue_(store, result, /*blocked=*/true);

  // ログシート（L_{sid}）にも1行残す
  try {
    writeLog({
      timestamp: new Date(),
      itemManageNumber: '',
      oldTitle: '',
      newTitle: '',
      eventKey: '',
      action: LOG_ACTIONS.ERROR,
      status: LOG_STATUS.FAILED,
      message: '[課金ゲート] 実行スキップ: ' + result.reason + ' - ' + result.message,
    }, store.sid);
  } catch (logErr) {
    Logger.log('[BillingGate] ログ書き込み失敗: ' + logErr.message);
  }

  return { allow: false, result: result };
}

/**
 * 課金ゲートの異常（ブロック or 疎通エラー）をGSD管理者に通知する。
 * 店舗自身の notifyEmail/notifySlack 設定とは独立（顧客に「あなたは未払いです」を自動送信しない設計）。
 */
function notifyBillingIssue_(store, result, blocked) {
  var adminEmail = getBillingAdminEmail_();
  if (!adminEmail) {
    Logger.log('[BillingGate] BILLING_ADMIN_EMAIL 未設定のため管理者通知をスキップしました');
    return;
  }

  var displayName = store.sname || store.sid;
  var subject = blocked
    ? '【課金ゲート】itemname 実行ブロック: ' + displayName
    : '【課金ゲート】itemname 疎通エラー（処理は続行しました）: ' + displayName;

  var body = [
    '店舗: ' + displayName + ' (sid: ' + store.sid + ', id: ' + store.id + ')',
    '判定: ' + (blocked ? 'ブロック' : '疎通エラー・フェイルオープンで続行'),
    '理由コード: ' + result.reason,
    'メッセージ: ' + result.message,
    '発生日時: ' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
  ].join('\n');

  try {
    GmailApp.sendEmail(adminEmail, subject, body);
  } catch (e) {
    Logger.log('[BillingGate] 管理者メール送信失敗: ' + e.message);
  }
}

// ==================== テスト（3状態検証） ====================
//
// 使い方（GASエディタから手動実行）:
//   1. ACCOUNT_API_URL と BILLING_ADMIN_EMAIL を ScriptProperties に設定
//   2. 下記3つの loginId 定数に、api_key シート上の実在テストデータのidを設定
//      （東京フラワーをパイロットテナントとする場合、まず「契約あり」のケースに東京フラワーの id を使う）
//   3. runBillingGateAllTests() を実行し、3ケースすべてPASSすることを確認
//
// このファイルはテストデータの id を埋め込むだけで、api_keyシート自体は一切変更しない。

var BILLING_GATE_TEST_IDS = {
  // 契約あり・支払い済み・有効期限内 → ok:true を期待
  SUBSCRIBED_ACTIVE: '',   // 例: 'tokyoflower'
  // servicesにitemnameが含まれない（未契約） → ok:false, reason:'NOT_SUBSCRIBED' を期待
  NOT_SUBSCRIBED: '',
  // servicesにitemnameは含まれるが expiry が過去 → ok:false, reason:'LICENSE_EXPIRED' を期待
  EXPIRED: '',
};

function testBillingGate_SubscribedActive() {
  return runBillingGateTestCase_('SUBSCRIBED_ACTIVE', BILLING_GATE_TEST_IDS.SUBSCRIBED_ACTIVE, true, null);
}

function testBillingGate_NotSubscribed() {
  return runBillingGateTestCase_('NOT_SUBSCRIBED', BILLING_GATE_TEST_IDS.NOT_SUBSCRIBED, false, 'NOT_SUBSCRIBED');
}

function testBillingGate_Expired() {
  return runBillingGateTestCase_('EXPIRED', BILLING_GATE_TEST_IDS.EXPIRED, false, 'LICENSE_EXPIRED');
}

function runBillingGateTestCase_(label, loginId, expectOk, expectReason) {
  Logger.log('=== BillingGate テスト: ' + label + ' ===');
  if (!loginId) {
    Logger.log('  ?? SKIP: BILLING_GATE_TEST_IDS.' + label + ' が未設定です');
    return { label: label, skipped: true };
  }

  var result = verifyBilling_(loginId, BILLING_GATE_SERVICE_NAME);
  var pass = (result.ok === expectOk) && (expectReason === null || result.reason === expectReason);

  Logger.log('  id: ' + loginId);
  Logger.log('  期待: ok=' + expectOk + (expectReason ? ' reason=' + expectReason : ''));
  Logger.log('  実際: ok=' + result.ok + ' reason=' + result.reason + ' message=' + result.message);
  Logger.log(pass ? '  ? PASS' : '  ? FAIL');

  return { label: label, skipped: false, pass: pass, result: result };
}

/**
 * 3状態まとめて実行
 */
function runBillingGateAllTests() {
  Logger.log('########## BillingGate 3状態検証 開始 ##########');
  var results = [
    testBillingGate_SubscribedActive(),
    testBillingGate_NotSubscribed(),
    testBillingGate_Expired(),
  ];

  var skipped = results.filter(function(r) { return r.skipped; }).length;
  var passed = results.filter(function(r) { return !r.skipped && r.pass; }).length;
  var failed = results.filter(function(r) { return !r.skipped && !r.pass; }).length;

  Logger.log('\n########## 結果サマリー ##########');
  Logger.log('PASS: ' + passed + ' / FAIL: ' + failed + ' / SKIP: ' + skipped);
  Logger.log('##################################');

  return results;
}
