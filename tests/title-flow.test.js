/**
 * 商品名ロジックのローカルテスト（GAS・RMS・スプレッドシートは呼ばない）
 *
 * 実行: node tests/title-flow.test.js
 *
 * gas/Constants.js・gas/TitleLogic.js・gas/Main.js をそのまま読み込み、
 * GAS固有のAPI（Utilities / Logger）とシート・RMSアクセス関数はスタブに差し替える。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ---- 実際に発生した事象の商品名（店舗: 花とギフト銀座東京フラワー / ota211125） ----
const PREVIEW_PREFIX = '【予告】お買い物マラソン';
// ツール上の「現在の商品名」（確認できている範囲。末尾は省略されていた）
const STALE_BASE = '銀座からお届け 八重咲 白ユリの花束 3本 9輪以上 ホワイトデー 母の日 送料無料';
const STACKED_TITLE = PREVIEW_PREFIX.repeat(5) + STALE_BASE;
// RMS上の実際の商品名
const RMS_TITLE = '＼銀座からお届け／ 八重咲 白ユリの花束 3本 9輪以上 送料無料 あす楽13時まで 土日も出荷 花 2026 花束 生花 大輪白ユリ 上質 八重 珍しい 大輪 誕生日 結婚祝い お供え お祝い ギフト ラッピング';

const ZERO_DAY = { eventKey: 'ZERO_DAY', priority: 2, prefixLong: '【本日0の日】', prefixMid: '【0の日】', prefixShort: '【0】' };
const PREVIEW = { eventKey: 'MARATHON', priority: 1, prefixLong: PREVIEW_PREFIX, prefixMid: PREVIEW_PREFIX, prefixShort: PREVIEW_PREFIX };
const SETTINGS = { dryRun: false, maxTitleZenkaku: 127, keepNonEventBrackets: true, apiSleepMs: 0 };

// ---- GASコードの読み込み ----
function createGas() {
  const state = {
    rms: {},          // manageNumber -> RMS上の商品名
    backups: {},      // manageNumber -> { originalTitle }
    sheetRows: {},    // rowIndex -> T_{sid} の行（更新内容をマージ）
    logs: [],
    events: [],       // EVENTSシートの全行
    restorePrefixes: { applied: [], finished: [] },
    failUpdate: false,
  };

  const context = vm.createContext({
    console,
    Logger: { log() {} },
    Utilities: { sleep() {} },
    // --- RMS（スタブ） ---
    getItem: (manageNumber) => (manageNumber in state.rms
      ? { success: true, item: { title: state.rms[manageNumber] } }
      : { success: false, error: { message: 'not found' } }),
    updateItemTitlesBatch: (items) => ({
      results: items.map((item) => {
        if (state.failUpdate) return { manageNumber: item.manageNumber, success: false, error: { message: 'stub error' } };
        state.rms[item.manageNumber] = item.newTitle;
        return { manageNumber: item.manageNumber, success: true };
      }),
    }),
    // --- シート（スタブ） ---
    saveBackup: (manageNumber, originalTitle) => { state.backups[manageNumber] = { originalTitle }; },
    updateTargetItemRow: (rowIndex, updates) => { state.sheetRows[rowIndex] = Object.assign(state.sheetRows[rowIndex] || {}, updates); },
    writeLogs: (entries) => { state.logs.push(...entries); },
    loadAllEvents: () => state.events,
    getRestorePrefixTexts_: (sid, includeApplied) =>
      state.restorePrefixes.finished.concat(includeApplied ? state.restorePrefixes.applied : []),
  });

  for (const file of ['Constants.js', 'TitleLogic.js', 'Main.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'gas', file), 'utf8');
    vm.runInContext(code, context, { filename: 'gas/' + file });
  }

  const call = (expr) => vm.runInContext(expr, context);
  return { state, context, call };
}

/** 定期実行1回分（runForStore の prefix登録 → processItems）を再現 */
function runOnce(gas, currentEvents, settings) {
  const { context, state } = gas;
  context.__events = currentEvents;
  context.__settings = Object.assign({}, SETTINGS, settings);
  context.__targets = Object.keys(state.rms).map((manageNumber, i) => ({
    itemManageNumber: manageNumber, rowIndex: i + 2, currentTitle: (state.sheetRows[i + 2] || {}).currentTitle || '',
  }));
  context.__backups = state.backups;
  return gas.call(`
    setKnownEventPrefixes_(collectKnownPrefixes_('SID', __events, false));
    processItems(__targets, __events, __settings, __backups, 'SID', {});
  `);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ==================== prefix除去 ====================

test('多重に付いた「【予告】お買い物マラソン」×5 をすべて外せる', () => {
  const gas = createGas();
  gas.context.__t = STACKED_TITLE;
  assert.strictEqual(gas.call('stripEventPrefixes(__t)'), STALE_BASE);
});

test('RMSの実際の商品名（prefixなし）は除去しても変わらない', () => {
  const gas = createGas();
  gas.context.__t = RMS_TITLE;
  assert.strictEqual(gas.call('stripEventPrefixes(__t)'), RMS_TITLE);
});

test('EVENTSシートのカスタムprefix・標準prefixが混在・多重でも外せる', () => {
  const gas = createGas();
  gas.context.__p = ['【年末大感謝祭】', '【感謝祭】'];
  gas.context.__t = '【本日0の日】【年末大感謝祭】' + PREVIEW_PREFIX + '【感謝祭】 【年末大感謝祭】' + RMS_TITLE;
  assert.strictEqual(gas.call('setKnownEventPrefixes_(__p); stripEventPrefixes(__t)'), RMS_TITLE);
});

test('1文字以下のprefixは登録されない（商品名の先頭を誤って削らない）', () => {
  const gas = createGas();
  gas.context.__p = ['＼', '', null];
  gas.context.__t = RMS_TITLE;
  assert.strictEqual(gas.call('setKnownEventPrefixes_(__p); stripEventPrefixes(__t)'), RMS_TITLE);
});

// ==================== 定期実行（多重付与の防止） ====================

test('カスタムprefixのイベント中に定期実行を5回繰り返しても、prefixは1つだけ', () => {
  const gas = createGas();
  gas.state.events = [PREVIEW];
  gas.state.rms.ota211125 = RMS_TITLE;
  for (let i = 0; i < 5; i++) runOnce(gas, [PREVIEW]);

  const title = gas.state.rms.ota211125;
  assert.strictEqual(title.split(PREVIEW_PREFIX).length - 1, 1, 'prefixの個数: ' + title);
  assert.ok(gas.call('calcZenkakuLength')(title) <= 127);
  // 2回目以降は「変更なし」でスキップされる
  assert.strictEqual(gas.state.sheetRows[2].status, 'SKIPPED');
});

test('イベント終了後の実行でprefixが外れ、RMSの元の商品名に戻る（EVENTSから行が消えていても）', () => {
  const gas = createGas();
  gas.state.events = [PREVIEW];
  gas.state.rms.ota211125 = RMS_TITLE;
  runOnce(gas, [PREVIEW]);
  assert.notStrictEqual(gas.state.rms.ota211125, RMS_TITLE);

  gas.state.events = []; // イベント行が削除・編集された想定（LEGACY_EVENT_PREFIXES で除去）
  runOnce(gas, []);
  assert.strictEqual(gas.state.rms.ota211125, RMS_TITLE);
});

test('既に5重に付いた商品名も、次の実行で1つ（イベント中）／0個（イベントなし）に直る', () => {
  const during = createGas();
  during.state.rms.ota211125 = STACKED_TITLE;
  during.state.backups.ota211125 = { originalTitle: STALE_BASE };
  runOnce(during, [PREVIEW]);
  assert.strictEqual(during.state.rms.ota211125, PREVIEW_PREFIX + STALE_BASE);

  const after = createGas();
  after.state.rms.ota211125 = STACKED_TITLE;
  after.state.backups.ota211125 = { originalTitle: STALE_BASE };
  runOnce(after, []);
  assert.strictEqual(after.state.rms.ota211125, STALE_BASE);
});

test('11/20「本日0の日」: RMSの実際の商品名に1つだけ付き、翌日の実行で元に戻る', () => {
  const gas = createGas();
  gas.state.events = [ZERO_DAY];
  gas.state.rms.ota211125 = RMS_TITLE;
  for (let i = 0; i < 3; i++) runOnce(gas, [ZERO_DAY]);
  assert.strictEqual(gas.state.rms.ota211125, '【本日0の日】' + RMS_TITLE);

  runOnce(gas, []);
  assert.strictEqual(gas.state.rms.ota211125, RMS_TITLE);
});

test('適用中の即時適用prefixは定期実行で外されない（復元予約まで残る）', () => {
  const gas = createGas();
  gas.state.restorePrefixes.applied = ['【ポイント10倍】'];
  gas.state.rms.item1 = '【ポイント10倍】' + RMS_TITLE;
  gas.state.backups.item1 = { originalTitle: RMS_TITLE };
  runOnce(gas, []);
  assert.strictEqual(gas.state.rms.item1, '【ポイント10倍】' + RMS_TITLE);
});

// ==================== 即時適用 ====================

test('即時適用: 同じprefixを2回適用しても1つだけ', () => {
  const gas = createGas();
  gas.context.__t = RMS_TITLE;
  const first = gas.call(`setKnownEventPrefixes_(['【ポイント10倍】']); buildApplyNowTitle_(__t, '【ポイント10倍】', 127)`);
  gas.context.__t = first;
  const second = gas.call(`buildApplyNowTitle_(__t, '【ポイント10倍】', 127)`);
  assert.strictEqual(first, '【ポイント10倍】' + RMS_TITLE);
  assert.strictEqual(second, first);
});

// ==================== 表示用の商品名（T_{sid} の currentTitle） ====================

test('手動変更の検知時、シートの「現在の商品名」はRMSの実際の商品名になる', () => {
  const gas = createGas();
  gas.state.rms.ota211125 = RMS_TITLE;
  gas.state.backups.ota211125 = { originalTitle: 'まったく別の商品名 胡蝶蘭 3本立ち 開店祝い' };
  gas.state.sheetRows[2] = { currentTitle: STACKED_TITLE }; // 以前の表示（古いまま残っていた値）
  runOnce(gas, [ZERO_DAY]);

  assert.strictEqual(gas.state.sheetRows[2].status, 'MANUAL_CHANGE');
  assert.strictEqual(gas.state.sheetRows[2].currentTitle, RMS_TITLE);
  assert.strictEqual(gas.state.rms.ota211125, RMS_TITLE, '手動変更の商品はRMSを書き換えない');
});

test('DryRun時、シートの「現在の商品名」はRMSの実際の商品名のまま（RMSも変更しない）', () => {
  const gas = createGas();
  gas.state.rms.ota211125 = RMS_TITLE;
  runOnce(gas, [ZERO_DAY], { dryRun: true });

  assert.strictEqual(gas.state.sheetRows[2].status, 'DRY_RUN');
  assert.strictEqual(gas.state.sheetRows[2].currentTitle, RMS_TITLE);
  assert.strictEqual(gas.state.rms.ota211125, RMS_TITLE);
  assert.strictEqual(gas.state.logs[0].newTitle, '【本日0の日】' + RMS_TITLE, '更新予定の商品名はログで確認できる');
});

test('RMS更新に失敗した場合、シートは実際の商品名・FAILEDに戻る', () => {
  const gas = createGas();
  gas.state.rms.ota211125 = RMS_TITLE;
  gas.state.failUpdate = true;
  runOnce(gas, [ZERO_DAY]);

  assert.strictEqual(gas.state.sheetRows[2].status, 'FAILED');
  assert.strictEqual(gas.state.sheetRows[2].currentTitle, RMS_TITLE);
});

test('RMS更新に成功した場合、シートは新しい商品名・SUCCESS', () => {
  const gas = createGas();
  gas.state.rms.ota211125 = RMS_TITLE;
  runOnce(gas, [ZERO_DAY]);

  assert.strictEqual(gas.state.sheetRows[2].status, 'SUCCESS');
  assert.strictEqual(gas.state.sheetRows[2].currentTitle, '【本日0の日】' + RMS_TITLE);
});

// ---- 実行 ----
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message).split('\n').join('\n      '));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
