/**
 * TitleLogic.gs
 * 商品名生成ロジック（prefix選択/文字数計測/スマート短縮/正規表現除去）
 * 
 * [ME-1] 複数イベント同時適用対応
 *   - getCurrentEvent → getCurrentEvents（複数返却）
 *   - buildTitle → buildTitleMulti（複数prefix連結）
 *   - 旧関数は互換性のため残存
 */

// ==================== イベント判定 ====================

/**
 * [ME-1] 現在適用中の全イベントを取得（複数返却）
 * @param {Date} now - 判定日時
 * @param {Array} events - イベント一覧
 * @param {Object} settings - 設定
 * @returns {Array} 適用イベント一覧（priority順）
 */
function getCurrentEvents(now, events, settings) {
  // 適用中のイベントを抽出
  const activeEvents = events.filter(event => {
    return now >= event.startDatetime && now <= event.endDatetime;
  });
  
  // 優先度でソート（小さいほど優先）
  activeEvents.sort((a, b) => a.priority - b.priority);
  
  // 当店倍率を追加（設定有効時）
  if (settings.shopMultiplierEnabled) {
    // 既にアクティブイベントがあっても、当店倍率は追加する
    activeEvents.push(createShopMultiplierEvent(settings.shopMultiplierRate));
  }
  
  return activeEvents;
}

/**
 * [互換性維持] 現在適用中のイベントを1つ取得（旧API）
 * @param {Date} now - 判定日時
 * @param {Array} events - イベント一覧
 * @param {Object} settings - 設定
 * @returns {Object|null} 適用イベント情報
 */
function getCurrentEvent(now, events, settings) {
  const activeEvents = getCurrentEvents(now, events, settings);
  return activeEvents.length > 0 ? activeEvents[0] : null;
}

/**
 * 当店倍率イベントを生成
 */
function createShopMultiplierEvent(rate) {
  return {
    eventKey: EVENT_KEYS.SHOP_MULTIPLIER,
    prefixLong: `【当店${rate}倍】`,
    prefixMid: `【店${rate}倍】`,
    prefixShort: `【${rate}倍】`,
    priority: 5,
  };
}

/**
 * イベントのprefix候補を取得（単一イベント用）
 */
function getPrefixCandidates(event) {
  if (!event) return [];
  return [
    event.prefixLong,
    event.prefixMid,
    event.prefixShort,
  ].filter(p => p && p.length > 0);
}

/**
 * [ME-1] 複数イベントのprefix候補を取得
 * @param {Array} currentEvents - 適用イベント一覧
 * @returns {Array} [{eventKey, candidates: [long, mid, short]}, ...]
 */
function getMultiPrefixCandidates(currentEvents) {
  if (!currentEvents || currentEvents.length === 0) return [];
  
  return currentEvents.map(event => ({
    eventKey: event.eventKey,
    priority: event.priority,
    candidates: [
      event.prefixLong,
      event.prefixMid,
      event.prefixShort,
    ].filter(p => p && p.length > 0),
  }));
}

// ==================== 文字数計算 ====================

/**
 * 全角換算の文字数を計算
 * 半角=0.5, 全角=1.0
 */
function calcZenkakuLength(str) {
  if (!str) return 0;
  let len = 0;
  for (const char of str) {
    // ASCII範囲（0x00-0x7F）は半角
    const code = char.charCodeAt(0);
    len += (code <= 0x7F) ? 0.5 : 1.0;
  }
  return len;
}

/**
 * バイト数を計算（UTF-8）
 */
function calcByteLength(str) {
  if (!str) return 0;
  return Utilities.newBlob(str).getBytes().length;
}

/**
 * 指定した全角文字数に収まるように切り詰め
 */
function truncateToZenkakuLimit(str, limit) {
  if (calcZenkakuLength(str) <= limit) return str;
  
  let result = '';
  let currentLen = 0;
  
  for (const char of str) {
    const charLen = (char.charCodeAt(0) <= 0x7F) ? 0.5 : 1.0;
    if (currentLen + charLen > limit) break;
    result += char;
    currentLen += charLen;
  }
  
  return result;
}

// ==================== Prefix除去 ====================

/**
 * イベントprefixを除去（先頭から連続するものをすべて）
 */
function stripEventPrefixes(title) {
  if (!title) return '';
  
  let result = title;
  let changed = true;
  let iterations = 0;
  const maxIterations = 20; // [ME-1] 複数prefix対応のため上限引き上げ
  
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    
    for (const pattern of EVENT_PREFIX_PATTERNS) {
      if (pattern.test(result)) {
        result = result.replace(pattern, '');
        changed = true;
        break;
      }
    }
  }
  
  return result.trim();
}

/**
 * イベント以外の装飾【】を除去
 */
function stripNonEventBrackets(title, keepList = []) {
  let result = title;
  
  for (const bracket of REMOVABLE_BRACKETS) {
    if (!keepList.includes(bracket)) {
      result = result.replace(bracket, '');
    }
  }
  
  return result.replace(/\s+/g, ' ').trim();
}

// ==================== [ME-1] 複数prefix対応の商品名生成 ====================

/**
 * [ME-1] 複数イベント対応の商品名生成
 * 
 * priority順に全イベントのprefixを連結し、文字数制限内に収める。
 * 収まらない場合は、低優先度イベントから順にprefix短縮→除外する。
 * 
 * @param {string} baseTitle - ベース商品名
 * @param {Array} multiPrefixCandidates - [{eventKey, priority, candidates: [long, mid, short]}, ...]
 * @param {number} limit - 全角文字数上限
 * @param {boolean} keepNonEventBrackets - イベント以外の【】を保持
 * @returns {Object} { title, prefixes: [{eventKey, prefix}], truncated }
 */
function buildTitleMulti(baseTitle, multiPrefixCandidates, limit, keepNonEventBrackets) {
  // イベントprefixを除去してベース名を取得
  let cleanBase = stripEventPrefixes(baseTitle);
  
  // prefixがない場合（イベントなし）
  if (!multiPrefixCandidates || multiPrefixCandidates.length === 0) {
    const finalTitle = truncateToZenkakuLimit(cleanBase, limit);
    return {
      title: finalTitle,
      prefixes: [],
      truncated: finalTitle !== cleanBase,
    };
  }
  
  // ===== Step 1: 全イベントにLong prefixを割り当てて試す =====
  // 各イベントの選択インデックス（0=long, 1=mid, 2=short）
  const selection = multiPrefixCandidates.map(() => 0);
  
  // 最適な組み合わせを探す
  const result = findBestPrefixCombination(cleanBase, multiPrefixCandidates, selection, limit, keepNonEventBrackets);
  
  return result;
}

/**
 * [ME-1] 最適なprefix組み合わせを探索
 * 
 * 戦略:
 *  1. 全イベントのLong prefixで試行
 *  2. 収まらなければ、低優先度（配列末尾）から順にMid→Shortへダウングレード
 *  3. 全てShortでも収まらなければ、低優先度から順に除外
 *  4. 最終的にベース名も短縮
 */
function findBestPrefixCombination(cleanBase, multiPrefixCandidates, selection, limit, keepNonEventBrackets) {
  const eventCount = multiPrefixCandidates.length;
  
  // ===== Phase 1: 全Long → 順次ダウングレード =====
  // 全イベントを含めた状態で、prefixサイズを調整
  for (let downgradePass = 0; downgradePass < eventCount * 3; downgradePass++) {
    const prefixStr = buildPrefixString(multiPrefixCandidates, selection);
    const prefixLen = calcZenkakuLength(prefixStr);
    const availableLen = limit - prefixLen;
    
    // ベース名がそのまま入る場合 → 採用
    if (calcZenkakuLength(cleanBase) <= availableLen) {
      return {
        title: prefixStr + cleanBase,
        prefixes: buildPrefixInfo(multiPrefixCandidates, selection),
        truncated: false,
      };
    }
    
    // ベース名を短縮して入る場合
    const shortenedBase = smartTruncate(cleanBase, availableLen, keepNonEventBrackets);
    if (calcZenkakuLength(shortenedBase) >= Math.min(availableLen, 30)) {
      return {
        title: prefixStr + shortenedBase,
        prefixes: buildPrefixInfo(multiPrefixCandidates, selection),
        truncated: true,
      };
    }
    
    // 低優先度（末尾）からダウングレード
    let downgraded = false;
    for (let i = eventCount - 1; i >= 0; i--) {
      const maxIndex = multiPrefixCandidates[i].candidates.length - 1;
      if (selection[i] < maxIndex) {
        selection[i]++;
        downgraded = true;
        break;
      }
    }
    
    if (!downgraded) break; // 全てShortになった
  }
  
  // ===== Phase 2: 低優先度イベントを除外 =====
  // 全てShortでも収まらない → 低優先度から除外
  const included = multiPrefixCandidates.map(() => true);
  
  for (let i = eventCount - 1; i >= 0; i--) {
    included[i] = false; // 除外
    
    const prefixStr = buildPrefixStringFiltered(multiPrefixCandidates, selection, included);
    const prefixLen = calcZenkakuLength(prefixStr);
    const availableLen = limit - prefixLen;
    
    if (calcZenkakuLength(cleanBase) <= availableLen) {
      return {
        title: prefixStr + cleanBase,
        prefixes: buildPrefixInfoFiltered(multiPrefixCandidates, selection, included),
        truncated: false,
      };
    }
    
    const shortenedBase = smartTruncate(cleanBase, availableLen, keepNonEventBrackets);
    if (calcZenkakuLength(shortenedBase) >= Math.min(availableLen, 30)) {
      return {
        title: prefixStr + shortenedBase,
        prefixes: buildPrefixInfoFiltered(multiPrefixCandidates, selection, included),
        truncated: true,
      };
    }
  }
  
  // ===== Phase 3: 最優先イベントのみ、最短prefix + 強制切り詰め =====
  const topEvent = multiPrefixCandidates[0];
  const shortestPrefix = topEvent.candidates[topEvent.candidates.length - 1];
  const availableLen = limit - calcZenkakuLength(shortestPrefix);
  const forceTruncated = truncateToZenkakuLimit(cleanBase, availableLen);
  
  return {
    title: shortestPrefix + forceTruncated,
    prefixes: [{ eventKey: topEvent.eventKey, prefix: shortestPrefix }],
    truncated: true,
  };
}

/**
 * [ME-1] 選択されたprefixを連結した文字列を生成
 */
function buildPrefixString(multiPrefixCandidates, selection) {
  let result = '';
  for (let i = 0; i < multiPrefixCandidates.length; i++) {
    const candidates = multiPrefixCandidates[i].candidates;
    const idx = Math.min(selection[i], candidates.length - 1);
    result += candidates[idx];
  }
  return result;
}

/**
 * [ME-1] フィルタ付きprefix連結
 */
function buildPrefixStringFiltered(multiPrefixCandidates, selection, included) {
  let result = '';
  for (let i = 0; i < multiPrefixCandidates.length; i++) {
    if (!included[i]) continue;
    const candidates = multiPrefixCandidates[i].candidates;
    const idx = Math.min(selection[i], candidates.length - 1);
    result += candidates[idx];
  }
  return result;
}

/**
 * [ME-1] 適用されたprefix情報を返却
 */
function buildPrefixInfo(multiPrefixCandidates, selection) {
  const result = [];
  for (let i = 0; i < multiPrefixCandidates.length; i++) {
    const candidates = multiPrefixCandidates[i].candidates;
    const idx = Math.min(selection[i], candidates.length - 1);
    result.push({
      eventKey: multiPrefixCandidates[i].eventKey,
      prefix: candidates[idx],
    });
  }
  return result;
}

/**
 * [ME-1] フィルタ付きprefix情報返却
 */
function buildPrefixInfoFiltered(multiPrefixCandidates, selection, included) {
  const result = [];
  for (let i = 0; i < multiPrefixCandidates.length; i++) {
    if (!included[i]) continue;
    const candidates = multiPrefixCandidates[i].candidates;
    const idx = Math.min(selection[i], candidates.length - 1);
    result.push({
      eventKey: multiPrefixCandidates[i].eventKey,
      prefix: candidates[idx],
    });
  }
  return result;
}

// ==================== [互換性維持] 旧buildTitle ====================

/**
 * 商品名を生成（単一prefix版 - 互換性維持）
 * @param {string} baseTitle - ベース商品名
 * @param {Array} prefixCandidates - prefix候補（長→短の順）
 * @param {number} limit - 全角文字数上限
 * @param {boolean} keepNonEventBrackets - イベント以外の【】を保持
 * @returns {Object} { title, prefix, truncated }
 */
function buildTitle(baseTitle, prefixCandidates, limit, keepNonEventBrackets) {
  // イベントprefixを除去してベース名を取得
  let cleanBase = stripEventPrefixes(baseTitle);
  
  // prefixがない場合（イベントなし）
  if (!prefixCandidates || prefixCandidates.length === 0) {
    const finalTitle = truncateToZenkakuLimit(cleanBase, limit);
    return {
      title: finalTitle,
      prefix: '',
      truncated: finalTitle !== cleanBase,
    };
  }
  
  // 各prefix候補を試す
  for (const prefix of prefixCandidates) {
    const prefixLen = calcZenkakuLength(prefix);
    const availableLen = limit - prefixLen;
    
    // ベース名がそのまま入る場合
    if (calcZenkakuLength(cleanBase) <= availableLen) {
      return {
        title: prefix + cleanBase,
        prefix: prefix,
        truncated: false,
      };
    }
    
    // 短縮を試みる
    const shortenedBase = smartTruncate(cleanBase, availableLen, keepNonEventBrackets);
    
    if (calcZenkakuLength(shortenedBase) >= Math.min(availableLen, 50)) {
      return {
        title: prefix + shortenedBase,
        prefix: prefix,
        truncated: true,
      };
    }
  }
  
  // 最短prefixでも入らない場合は最短prefixで強制切り詰め
  const shortestPrefix = prefixCandidates[prefixCandidates.length - 1];
  const availableLen = limit - calcZenkakuLength(shortestPrefix);
  const forceTruncated = truncateToZenkakuLimit(cleanBase, availableLen);
  
  return {
    title: shortestPrefix + forceTruncated,
    prefix: shortestPrefix,
    truncated: true,
  };
}

// ==================== スマート短縮 ====================

/**
 * スマート短縮（文脈を考慮した短縮）
 */
function smartTruncate(title, targetLen, keepNonEventBrackets) {
  let result = title;
  
  // Step 1: イベント以外の装飾【】を削除（設定による）
  if (!keepNonEventBrackets) {
    result = stripNonEventBrackets(result);
    if (calcZenkakuLength(result) <= targetLen) return result;
  }
  
  // Step 2: 末尾キーワードを削除
  result = removeTailKeywords(result, targetLen);
  if (calcZenkakuLength(result) <= targetLen) return result;
  
  // Step 3: 類似キーワードを統合
  result = deduplicateSimilarKeywords(result);
  if (calcZenkakuLength(result) <= targetLen) return result;
  
  // Step 4: 単語境界で切り詰め
  result = truncateAtWordBoundary(result, targetLen);
  
  return result;
}

/**
 * 末尾キーワードを削除
 */
function removeTailKeywords(title, targetLen) {
  let result = title;
  const words = result.split(/\s+/);
  
  // 最低3語は残す
  while (words.length > 3 && calcZenkakuLength(words.join(' ')) > targetLen) {
    const lastWord = words[words.length - 1];
    
    let shouldRemove = false;
    for (const keyword of TAIL_KEYWORDS_TO_REMOVE) {
      if (keyword instanceof RegExp) {
        if (keyword.test(lastWord)) shouldRemove = true;
      } else {
        if (lastWord.toLowerCase() === keyword.toLowerCase()) shouldRemove = true;
      }
    }
    
    if (calcZenkakuLength(lastWord) <= 4) shouldRemove = true;
    
    if (shouldRemove) {
      words.pop();
    } else {
      break;
    }
  }
  
  return words.join(' ');
}

/**
 * 類似キーワードを統合
 */
function deduplicateSimilarKeywords(title) {
  const similarGroups = [
    ['クリスタルベール', 'クリスタルヴェール'],
    ['ギフト', 'プレゼント', '贈り物'],
    ['オシャレ', 'おしゃれ', 'オシャレ'],
  ];
  
  let result = title;
  
  for (const group of similarGroups) {
    let found = false;
    for (const keyword of group) {
      if (result.includes(keyword)) {
        if (found) {
          result = result.replace(keyword, '');
        } else {
          found = true;
        }
      }
    }
  }
  
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * 単語境界で切り詰め
 */
function truncateAtWordBoundary(title, targetLen) {
  const result = truncateToZenkakuLimit(title, targetLen);
  
  const boundaryChars = [' ', '　', '/', '／', '-', '?', '・'];
  let lastBoundary = -1;
  
  for (const char of boundaryChars) {
    const pos = result.lastIndexOf(char);
    if (pos > lastBoundary && pos > result.length * 0.7) {
      lastBoundary = pos;
    }
  }
  
  if (lastBoundary > 0) {
    return result.substring(0, lastBoundary).trim();
  }
  
  return result;
}

// ==================== 手動変更検知 ====================

function detectManualChange(currentTitle, backupTitle) {
  if (!backupTitle) return false;
  
  const strippedCurrent = stripEventPrefixes(currentTitle);
  
  if (strippedCurrent === backupTitle) return false;
  
  const similarity = calculateSimilarity(strippedCurrent, backupTitle);
  
  return similarity < 0.8;
}

function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;
  
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1;
  
  if (longer.includes(shorter)) return shorter.length / longer.length;
  
  let matches = 0;
  for (const char of shorter) {
    if (longer.includes(char)) matches++;
  }
  
  return matches / longer.length;
}

// ==================== テスト用関数 ====================

/**
 * [ME-1] 複数イベント同時適用のテスト
 */
function testBuildTitleMulti() {
  Logger.log('=== 複数イベント同時適用テスト ===');
  
  // テスト1: マラソン予告 + いちばの日
  const testEvents1 = [
    { eventKey: 'MARATHON', priority: 1, candidates: ['【予告】お買い物マラソン】', '【予告マラソン】', '【予告SALE】'] },
    { eventKey: 'ICHIBA_DAY', priority: 3, candidates: ['【いちばの日】', '【市場の日】', '【市】'] },
  ];
  
  const base1 = '観葉植物 パキラ 8号鉢 送料無料';
  Logger.log('ベース: ' + base1);
  Logger.log('イベント: マラソン予告 + いちばの日');
  
  const result1 = buildTitleMulti(base1, testEvents1, 127, true);
  Logger.log('結果: ' + result1.title);
  Logger.log('適用prefix: ' + result1.prefixes.map(p => p.prefix).join(' + '));
  Logger.log('短縮: ' + result1.truncated);
  Logger.log('文字数: ' + calcZenkakuLength(result1.title));
  Logger.log('');
  
  // テスト2: マラソン + 5の日（マラソン中の5の日）
  const testEvents2 = [
    { eventKey: 'MARATHON', priority: 1, candidates: ['【お買い物マラソン】', '【マラソン】', '【SALE】'] },
    { eventKey: 'FIVE_DAY', priority: 2, candidates: ['【本日5の日】', '【5の日】', '【5】'] },
  ];
  
  const base2 = '＼母の日限定 ナチュラル系アジサイ！／ ラグランジア 鉢植え 5号鉢 2026年 5月 ギフト 紫陽花 オシャレ アジサイ ナチュラル ガクアジサイ ブライダルシャワー クリスタルベール クリスタルヴェール シャンデリーニ バレンタイン ホワイトデー 送料無料 白 グリーン haha';
  Logger.log('ベース: ' + base2);
  Logger.log('イベント: マラソン + 5の日');
  
  const result2 = buildTitleMulti(base2, testEvents2, 127, true);
  Logger.log('結果: ' + result2.title);
  Logger.log('適用prefix: ' + result2.prefixes.map(p => p.prefix).join(' + '));
  Logger.log('短縮: ' + result2.truncated);
  Logger.log('文字数: ' + calcZenkakuLength(result2.title));
  Logger.log('');
  
  // テスト3: イベントなし
  Logger.log('ベース: ' + base1);
  Logger.log('イベント: なし');
  
  const result3 = buildTitleMulti(base1, [], 127, true);
  Logger.log('結果: ' + result3.title);
  Logger.log('適用prefix: なし');
  Logger.log('短縮: ' + result3.truncated);
  Logger.log('');
  
  // テスト4: 単一イベント（従来動作の確認）
  const testEvents4 = [
    { eventKey: 'FIVE_DAY', priority: 2, candidates: ['【本日5の日】', '【5の日】', '【5】'] },
  ];
  
  Logger.log('ベース: ' + base1);
  Logger.log('イベント: 5の日のみ');
  
  const result4 = buildTitleMulti(base1, testEvents4, 127, true);
  Logger.log('結果: ' + result4.title);
  Logger.log('適用prefix: ' + result4.prefixes.map(p => p.prefix).join(' + '));
  Logger.log('短縮: ' + result4.truncated);
}

/**
 * 商品名生成のテスト（旧版 - 互換性維持）
 */
function testBuildTitle() {
  const testCases = [
    {
      baseTitle: '＼母の日限定 ナチュラル系アジサイ！／ ラグランジア 鉢植え 5号鉢 2026年 5月 ギフト 紫陽花 オシャレ アジサイ ナチュラル ガクアジサイ ブライダルシャワー クリスタルベール クリスタルヴェール シャンデリーニ バレンタイン ホワイトデー 送料無料 白 グリーン haha',
      prefix: ['【本日5の日】', '【5の日】', '【5】'],
    },
    {
      baseTitle: '【送料無料】観葉植物 パキラ 8号鉢',
      prefix: ['【お買い物マラソン】', '【マラソン】', '【SALE】'],
    },
  ];
  
  for (const tc of testCases) {
    Logger.log('=== テストケース ===');
    Logger.log('元の商品名: ' + tc.baseTitle);
    Logger.log('文字数(全角換算): ' + calcZenkakuLength(tc.baseTitle));
    
    const result = buildTitle(tc.baseTitle, tc.prefix, 127, true);
    Logger.log('生成後: ' + result.title);
    Logger.log('使用prefix: ' + result.prefix);
    Logger.log('短縮: ' + result.truncated);
    Logger.log('文字数(全角換算): ' + calcZenkakuLength(result.title));
    Logger.log('');
  }
}