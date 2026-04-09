/**
 * 商品名自動修正侍 - Frontend JavaScript
 * GAS Web API との連携
 * 
 * [ROLE] 管理者/一般ユーザー表示制御対応
 */

// ==================== 設定 ====================
const API_URL = 'https://script.google.com/macros/s/AKfycbwL_odLRjbnirbyP18mtvOX5Uks7T-Gcc5uuyGlbOYtOjF5Dn6mv9gspiVcqEqK4g1l/exec';

// 削除対象の一時保存
let deleteTargetItem = null;

// ==================== セッション管理 ====================
const Session = {
  save(data) {
    sessionStorage.setItem('samurai_session', JSON.stringify(data));
  },
  
  get() {
    const data = sessionStorage.getItem('samurai_session');
    return data ? JSON.parse(data) : null;
  },
  
  clear() {
    sessionStorage.removeItem('samurai_session');
  },
  
  isLoggedIn() {
    const session = this.get();
    return session && session.token && session.userId;
  }
};

// [ROLE] 管理者判定ヘルパー
function isAdmin() {
  const session = Session.get();
  return session && session.role === 'admin';
}

// ==================== API通信 ====================
async function apiRequest(action, data = {}) {
  const session = Session.get();
  
  const payload = {
    action,
    ...data,
  };
  
  // セッション情報を追加
  if (session) {
    payload.token = session.token;
    payload.userId = session.userId;
  }
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify(payload),
    });
    
    const result = await response.json();
    return result;
    
  } catch (error) {
    console.error('API Error:', error);
    return {
      success: false,
      message: 'サーバーとの通信に失敗しました。',
    };
  }
}

// ==================== 初期化 ====================
document.addEventListener('DOMContentLoaded', () => {
  // セッション確認
  if (Session.isLoggedIn()) {
    showDashboard();
    loadDashboardData();
  } else {
    showLogin();
  }
  
  // タブ切り替え
  setupTabs();
});

// ==================== 画面切り替え ====================
function showLogin() {
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('dashboardPage').style.display = 'none';
  document.getElementById('userInfo').style.display = 'none';
}

function showDashboard() {
  const session = Session.get();
  
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('dashboardPage').style.display = 'block';
  document.getElementById('userInfo').style.display = 'flex';
  document.getElementById('shopName').textContent = session.shopName || session.userId;
  
  // [ROLE] 管理者/一般ユーザーの表示制御
  applyRoleVisibility();
}

/**
 * [ROLE] ロールに基づいてUIの表示/非表示を制御
 */
function applyRoleVisibility() {
  const adminElements = document.querySelectorAll('.admin-only');
  
  if (isAdmin()) {
    adminElements.forEach(el => el.classList.remove('hidden'));
  } else {
    adminElements.forEach(el => el.classList.add('hidden'));
  }
}

// ==================== ログイン ====================
async function handleLogin(event) {
  event.preventDefault();
  
  const userId = document.getElementById('userId').value.trim();
  const password = document.getElementById('password').value;
  const loginBtn = document.getElementById('loginBtn');
  const errorDiv = document.getElementById('loginError');
  
  // ボタン状態変更
  setButtonLoading(loginBtn, true);
  errorDiv.classList.remove('show');
  
  try {
    const result = await apiRequest('login', { userId, password });
    
    if (result.success) {
      // [ROLE] セッション保存にrole追加
      Session.save({
        userId: result.data.userId,
        token: result.data.token,
        shopName: result.data.shopName,
        email: result.data.email,
        expiry: result.data.expiry,
        role: result.data.role || 'user',
      });
      
      showToast('ログインしました', 'success');
      showDashboard();
      loadDashboardData();
      
    } else {
      errorDiv.textContent = result.message || 'ログインに失敗しました';
      errorDiv.classList.add('show');
    }
    
  } catch (error) {
    errorDiv.textContent = 'サーバーとの通信に失敗しました';
    errorDiv.classList.add('show');
  } finally {
    setButtonLoading(loginBtn, false);
  }
}

function logout() {
  Session.clear();
  showLogin();
  showToast('ログアウトしました', 'success');
  
  // フォームリセット
  document.getElementById('userId').value = '';
  document.getElementById('password').value = '';
  document.getElementById('loginError').classList.remove('show');
}

// ==================== ダッシュボードデータ読み込み ====================
async function loadDashboardData() {
  await Promise.all([
    loadSettings(),
    loadEvents(),
    loadTargetItems(),
  ]);
  
  updateStatusCards();
}

async function updateStatusCards() {
  const session = Session.get();
  
  // 有効期限
  if (session.expiry) {
    const expiry = new Date(session.expiry);
    document.getElementById('expiryDate').textContent = formatDate(expiry);
  } else {
    document.getElementById('expiryDate').textContent = '無期限';
  }
}

// ==================== 設定 ====================
async function loadSettings() {
  const result = await apiRequest('getSettings');
  
  if (result.success) {
    const settings = result.data.settings;
    
    // 共通設定（全ユーザー表示）
    document.getElementById('settingMode').value = settings.mode || 'TARGET_LIST';
    document.getElementById('settingNotifySlack').checked = settings.notifySlack || false;
    document.getElementById('settingNotifyEmail').checked = settings.notifyEmail || false;
    
    // 管理者専用設定（非表示でもフォーム値はセット）
    document.getElementById('settingDryRun').value = String(settings.dryRun);
    document.getElementById('settingMaxItems').value = settings.maxItemsPerRun || 500;
    
    // ステータスカード更新
    document.getElementById('targetItemsCount').textContent = result.data.targetItemsCount + '件';
    
    document.getElementById('currentMode').textContent = settings.dryRun ? 'DryRun' : '本番';
    
  } else {
    showToast(result.message || '設定の読み込みに失敗しました', 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  
  const btn = document.getElementById('saveSettingsBtn');
  setButtonLoading(btn, true);
  
  // 共通設定
  const settings = {
    mode: document.getElementById('settingMode').value,
    dryRun: document.getElementById('settingDryRun').value === 'true',
    notifySlack: document.getElementById('settingNotifySlack').checked,
    notifyEmail: document.getElementById('settingNotifyEmail').checked,
  };

  // [ROLE] 管理者のみ: 最大処理件数を含める
  if (isAdmin()) {
    settings.maxItemsPerRun = parseInt(document.getElementById('settingMaxItems').value, 10);
  }
  
  try {
    const result = await apiRequest('updateSettings', { settings });
    
    if (result.success) {
      showToast('設定を保存しました', 'success');
      loadSettings(); // 再読み込み
    } else {
      showToast(result.message || '設定の保存に失敗しました', 'error');
    }
  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// ==================== 対象商品管理 ====================
async function loadTargetItems() {
  const tbody = document.querySelector('#itemsTable tbody');
  const countDisplay = document.getElementById('itemsCountDisplay');
  
  // ローディング表示
  tbody.innerHTML = '<tr><td colspan="5" class="loading"><span class="spinner-dark"></span> 読み込み中...</td></tr>';
  
  const result = await apiRequest('getTargetItems');
  
  if (result.success && result.data.items) {
    const items = result.data.items;
    countDisplay.textContent = items.length;
    
    // ステータスカードも更新
    document.getElementById('targetItemsCount').textContent = items.length + '件';
    
    if (items.length > 0) {
      tbody.innerHTML = items.map(item => {
        let statusBadge = '';
        switch (item.status) {
          case 'SUCCESS':
            statusBadge = '<span class="badge badge-success">成功</span>';
            break;
          case 'FAILED':
            statusBadge = '<span class="badge badge-error">失敗</span>';
            break;
          case 'SKIPPED':
            statusBadge = '<span class="badge badge-warning">スキップ</span>';
            break;
          case 'MANUAL_CHANGE':
            statusBadge = '<span class="badge badge-warning">手動変更</span>';
            break;
          case '新規追加':
            statusBadge = '<span class="badge badge-info">新規</span>';
            break;
          default:
            statusBadge = item.status ? `<span class="badge badge-gray">${item.status}</span>` : '-';
        }
        
        const lastUpdated = item.lastUpdated ? formatDatetime(new Date(item.lastUpdated)) : '-';
        const title = item.currentTitle || item.baseTitle || '-';
        
        return `
          <tr>
            <td class="item-number">${escapeHtml(item.itemManageNumber)}</td>
            <td class="item-title" title="${escapeHtml(title)}">${escapeHtml(title)}</td>
            <td>${statusBadge}</td>
            <td>${lastUpdated}</td>
            <td>
              <button class="btn-secondary btn-icon" onclick="showDeleteConfirm('${escapeHtml(item.itemManageNumber)}', ${item.rowIndex})" title="削除">
                🗑️
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="loading">対象商品が登録されていません</td></tr>';
    }
    
  } else {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">読み込みに失敗しました</td></tr>';
    countDisplay.textContent = '0';
  }
}

// 商品追加モーダル表示
function showAddItemModal() {
  document.getElementById('newItemNumbers').value = '';
  document.getElementById('addItemModal').style.display = 'flex';
  hideModalLoading('addItemModal');
}

// 商品追加モーダル非表示
function hideAddItemModal() {
  document.getElementById('addItemModal').style.display = 'none';
  hideModalLoading('addItemModal');
}

// 商品追加
async function addTargetItems() {
  const textarea = document.getElementById('newItemNumbers');
  const itemNumbers = textarea.value.trim();
  const btn = document.getElementById('addItemBtn');
  
  if (!itemNumbers) {
    showToast('商品管理番号を入力してください', 'warning');
    return;
  }
  
  // 追加件数をカウント
  const count = itemNumbers.split(/[\n,]/).filter(s => s.trim()).length;
  
  setButtonLoading(btn, true);
  showAddItemLoading(count);
  
  try {
    const result = await apiRequest('bulkAddTargetItems', { itemNumbers });
    
    if (result.success) {
      showToast(result.message, 'success');
      hideAddItemModal();
      loadTargetItems();
    } else {
      showToast(result.message || '追加に失敗しました', 'error');
      hideModalLoading('addItemModal');
    }
    
  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
    hideModalLoading('addItemModal');
  } finally {
    setButtonLoading(btn, false);
  }
}

// 削除確認モーダル表示
function showDeleteConfirm(itemManageNumber, rowIndex) {
  deleteTargetItem = { itemManageNumber, rowIndex };
  document.getElementById('deleteTargetNumber').textContent = itemManageNumber;
  document.getElementById('deleteConfirmModal').style.display = 'flex';
  hideModalLoading('deleteConfirmModal');
  
  // ボタンをリセット
  const btn = document.getElementById('confirmDeleteBtn');
  btn.disabled = false;
  btn.innerHTML = '削除';
}

// 削除確認モーダル非表示
function hideDeleteConfirmModal() {
  document.getElementById('deleteConfirmModal').style.display = 'none';
  hideModalLoading('deleteConfirmModal');
  deleteTargetItem = null;
}

// 削除実行
async function confirmDeleteItem() {
  if (!deleteTargetItem) return;
  
  const btn = document.getElementById('confirmDeleteBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 削除中...';
  showDeleteLoading();
  
  try {
    const result = await apiRequest('deleteTargetItem', { 
      itemManageNumber: deleteTargetItem.itemManageNumber 
    });
    
    if (result.success) {
      showToast('商品を削除しました', 'success');
      hideDeleteConfirmModal();
      loadTargetItems();
    } else {
      showToast(result.message || '削除に失敗しました', 'error');
      hideModalLoading('deleteConfirmModal');
    }
    
  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
    hideModalLoading('deleteConfirmModal');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '削除';
  }
}

// ==================== リッチローディングアニメーション ====================

// 商品追加用ローディング
function showAddItemLoading(count) {
  const modal = document.getElementById('addItemModal');
  if (!modal) return;
  
  // 既存のローディングを削除
  const existing = modal.querySelector('.modal-loading-overlay');
  if (existing) existing.remove();
  
  // ローディングオーバーレイを追加
  const overlay = document.createElement('div');
  overlay.className = 'modal-loading-overlay';
  overlay.innerHTML = `
    <div class="modal-loading-content">
      <div class="loading-animation">
        <div class="loading-pulse"></div>
        <div class="loading-pulse"></div>
        <div class="loading-ring"></div>
        <div class="loading-package">📦</div>
      </div>
      <div class="loading-dots">
        <div class="loading-dot"></div>
        <div class="loading-dot"></div>
        <div class="loading-dot"></div>
      </div>
      <div class="loading-progress">
        <div class="loading-progress-bar"></div>
      </div>
      <div class="loading-text">商品情報を取得中...</div>
      <div class="loading-subtext">${count}件の商品を処理しています</div>
    </div>
  `;
  
  const modalElement = modal.querySelector('.modal');
  if (modalElement) {
    modalElement.appendChild(overlay);
  }
}

// 削除用ローディング
function showDeleteLoading() {
  const modal = document.getElementById('deleteConfirmModal');
  if (!modal) return;
  
  // 既存のローディングを削除
  const existing = modal.querySelector('.modal-loading-overlay');
  if (existing) existing.remove();
  
  // ローディングオーバーレイを追加
  const overlay = document.createElement('div');
  overlay.className = 'modal-loading-overlay';
  overlay.innerHTML = `
    <div class="modal-loading-content">
      <div class="loading-delete-animation">
        <div class="delete-particles">
          <div class="delete-particle"></div>
          <div class="delete-particle"></div>
          <div class="delete-particle"></div>
          <div class="delete-particle"></div>
        </div>
        <div class="loading-delete-icon">🗑️</div>
      </div>
      <div class="loading-dots">
        <div class="loading-dot"></div>
        <div class="loading-dot"></div>
        <div class="loading-dot"></div>
      </div>
      <div class="loading-text">削除中...</div>
      <div class="loading-subtext">しばらくお待ちください</div>
    </div>
  `;
  
  const modalElement = modal.querySelector('.modal');
  if (modalElement) {
    modalElement.appendChild(overlay);
  }
}

// 汎用ローディング非表示
function hideModalLoading(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  
  const overlay = modal.querySelector('.modal-loading-overlay');
  if (overlay) overlay.remove();
}

// ==================== イベント ====================
async function loadEvents() {
  const tbody = document.querySelector('#eventsTable tbody');
  const colSpan = isAdmin() ? 6 : 5;

  // ローディング表示
  tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading"><span class="spinner-dark"></span> 読み込み中...</td></tr>`;

  const result = await apiRequest('getEvents', { futureOnly: true });

  if (result.success && result.data.events.length > 0) {
    const now = new Date();
    let nextEvent = null;
    const admin = isAdmin();

    tbody.innerHTML = result.data.events.map(event => {
      const start = new Date(event.startDatetime);
      const end = new Date(event.endDatetime);
      const isActive = now >= start && now <= end;
      const isPast = now > end;

      if (!nextEvent && start > now && event.enabled) {
        nextEvent = event;
      }

      let statusBadge = '';
      if (!event.enabled) {
        statusBadge = '<span class="badge badge-gray">無効</span>';
      } else if (isActive) {
        statusBadge = '<span class="badge badge-active">開催中</span>';
      } else if (isPast) {
        statusBadge = '<span class="badge badge-info">終了</span>';
      } else {
        statusBadge = '<span class="badge badge-success">予定</span>';
      }

      const rowClass = event.enabled ? '' : ' class="row-disabled"';

      let actionsCol = '';
      if (admin) {
        const toggleLabel = event.enabled ? 'OFF' : 'ON';
        const toggleClass = event.enabled ? 'btn-warning' : 'btn-success-sm';
        actionsCol = `
          <td class="admin-only">
            <button class="btn-sm ${toggleClass}" onclick="toggleEvent(${event.rowIndex})" title="${event.enabled ? '無効にする' : '有効にする'}">${toggleLabel}</button>
            <button class="btn-secondary btn-icon btn-sm" onclick="deleteEvent(${event.rowIndex}, '${escapeHtml(event.eventKey)}')" title="削除">🗑️</button>
          </td>
        `;
      }

      return `
        <tr${rowClass}>
          <td><strong>${escapeHtml(event.eventKey)}</strong></td>
          <td>${escapeHtml(event.prefixLong)}</td>
          <td>${formatDatetime(start)}</td>
          <td>${formatDatetime(end)}</td>
          <td>${statusBadge}</td>
          ${actionsCol}
        </tr>
      `;
    }).join('');

    // 次回イベント表示
    if (nextEvent) {
      const nextStart = new Date(nextEvent.startDatetime);
      document.getElementById('nextEvent').textContent =
        `${nextEvent.prefixLong} (${formatDate(nextStart)})`;
    } else {
      document.getElementById('nextEvent').textContent = '-';
    }

  } else {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="loading">イベントがありません</td></tr>`;
    document.getElementById('nextEvent').textContent = '-';
  }

  // 管理者表示制御を再適用
  applyRoleVisibility();
}

// イベント自動生成（2ヶ月分）
async function generateEvents() {
  if (!confirm('定期イベントを自動生成します（2ヶ月分）。\n既存のマラソン以外のイベントは再生成されます。\nよろしいですか？')) {
    return;
  }

  const btn = document.getElementById('generateEventsBtn');
  setButtonLoading(btn, true);

  try {
    const result = await apiRequest('generateEvents');

    if (result.success) {
      showToast(result.message, 'success');
      loadEvents();
    } else {
      showToast(result.message || 'イベント生成に失敗しました', 'error');
    }

  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// イベント種類ごとのプリセット
const EVENT_PRESETS = {
  MARATHON:      { priority: 1, prefixLong: '【お買い物マラソン】', prefixMid: '【マラソン】', prefixShort: '【SALE】' },
  WONDERFUL_DAY: { priority: 4, prefixLong: '【ワンダフルデー】',   prefixMid: '【Wデー】',    prefixShort: '【WD】' },
  FIVE_DAY:      { priority: 2, prefixLong: '【本日5の日】',       prefixMid: '【5の日】',    prefixShort: '【5】' },
  ZERO_DAY:      { priority: 2, prefixLong: '【本日0の日】',       prefixMid: '【0の日】',    prefixShort: '【0】' },
  ICHIBA_DAY:    { priority: 3, prefixLong: '【いちばの日】',      prefixMid: '【市場の日】',  prefixShort: '【市】' },
};

// イベント追加モーダル
function showAddEventModal() {
  document.getElementById('eventType').value = 'MARATHON';
  document.getElementById('eventPriority').value = '1';
  document.getElementById('eventStart').value = '';
  document.getElementById('eventEnd').value = '';
  document.getElementById('customEventKey').value = '';
  document.getElementById('customPrefixLong').value = '';
  document.getElementById('customPrefixMid').value = '';
  document.getElementById('customPrefixShort').value = '';
  document.getElementById('customEventFields').style.display = 'none';
  document.getElementById('addEventModal').style.display = 'flex';
}

function hideAddEventModal() {
  document.getElementById('addEventModal').style.display = 'none';
}

function onEventTypeChange() {
  const eventType = document.getElementById('eventType').value;
  const customFields = document.getElementById('customEventFields');

  if (eventType === 'CUSTOM') {
    customFields.style.display = 'block';
    document.getElementById('eventPriority').value = '4';
  } else {
    customFields.style.display = 'none';
    const preset = EVENT_PRESETS[eventType];
    if (preset) {
      document.getElementById('eventPriority').value = String(preset.priority);
    }
  }
}

// イベント追加
async function addEvent() {
  const eventType = document.getElementById('eventType').value;
  const startInput = document.getElementById('eventStart').value;
  const endInput = document.getElementById('eventEnd').value;
  const priority = parseInt(document.getElementById('eventPriority').value, 10) || 4;

  if (!startInput || !endInput) {
    showToast('開始日時と終了日時を入力してください', 'warning');
    return;
  }

  let eventKey, prefixLong, prefixMid, prefixShort;

  if (eventType === 'CUSTOM') {
    eventKey = document.getElementById('customEventKey').value.trim();
    prefixLong = document.getElementById('customPrefixLong').value.trim();
    prefixMid = document.getElementById('customPrefixMid').value.trim();
    prefixShort = document.getElementById('customPrefixShort').value.trim();

    if (!eventKey) {
      showToast('イベントキーを入力してください', 'warning');
      return;
    }
    if (!prefixLong) {
      showToast('Prefix（長）を入力してください', 'warning');
      return;
    }
  } else {
    const preset = EVENT_PRESETS[eventType];
    eventKey = eventType;
    prefixLong = preset.prefixLong;
    prefixMid = preset.prefixMid;
    prefixShort = preset.prefixShort;
  }

  // datetime-local → "YYYY/MM/DD HH:mm:ss" 形式に変換
  const startDatetime = startInput.replace('T', ' ').replace(/-/g, '/') + ':00';
  const endDatetime = endInput.replace('T', ' ').replace(/-/g, '/') + ':00';

  const btn = document.getElementById('addEventBtn');
  setButtonLoading(btn, true);

  try {
    const result = await apiRequest('addEvent', {
      eventKey, startDatetime, endDatetime, priority,
      prefixLong, prefixMid: prefixMid || prefixLong, prefixShort: prefixShort || prefixLong,
    });

    if (result.success) {
      showToast(result.message, 'success');
      hideAddEventModal();
      loadEvents();
    } else {
      showToast(result.message || '追加に失敗しました', 'error');
    }

  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// イベント削除
async function deleteEvent(rowIndex, eventKey) {
  if (!confirm(`イベント「${eventKey}」を削除しますか？`)) {
    return;
  }

  try {
    const result = await apiRequest('deleteEvent', { rowIndex });

    if (result.success) {
      showToast(result.message, 'success');
      loadEvents();
    } else {
      showToast(result.message || '削除に失敗しました', 'error');
    }

  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
  }
}

// イベント有効/無効切替
async function toggleEvent(rowIndex) {
  try {
    const result = await apiRequest('toggleEvent', { rowIndex });

    if (result.success) {
      showToast(result.message, 'success');
      loadEvents();
    } else {
      showToast(result.message || '切替に失敗しました', 'error');
    }

  } catch (error) {
    showToast('サーバーとの通信に失敗しました', 'error');
  }
}

// ==================== ログ ====================
async function loadLogs() {
  const tbody = document.querySelector('#logsTable tbody');

  // ローディング表示
  tbody.innerHTML = '<tr><td colspan="6" class="loading"><span class="spinner-dark"></span> 読み込み中...</td></tr>';
  
  const result = await apiRequest('getLogs', { limit: 50 });
  
  if (result.success && result.data.logs.length > 0) {
    // 新しい順（降順）にソート
    const sortedLogs = result.data.logs.sort((a, b) => {
      const dateA = new Date(a.timestamp);
      const dateB = new Date(b.timestamp);
      return dateB - dateA; // 降順
    });
    
    tbody.innerHTML = sortedLogs.map(log => {
      let statusBadge = '';
      switch (log.status) {
        case 'SUCCESS':
          statusBadge = '<span class="badge badge-success">成功</span>';
          break;
        case 'FAILED':
          statusBadge = '<span class="badge badge-error">失敗</span>';
          break;
        case 'DRY_RUN':
          statusBadge = '<span class="badge badge-info">DryRun</span>';
          break;
        case 'SKIPPED':
          statusBadge = '<span class="badge badge-warning">スキップ</span>';
          break;
        case 'MANUAL_CHANGE':
          statusBadge = '<span class="badge badge-warning">手動変更</span>';
          break;
        default:
          statusBadge = `<span class="badge">${log.status}</span>`;
      }
      
      const timestamp = log.timestamp ? formatDatetime(new Date(log.timestamp)) : '-';
      
      const oldTitle = escapeHtml(log.oldTitle || '-');
      const newTitle = escapeHtml(log.newTitle || '-');
      const titleChanged = log.oldTitle && log.newTitle && log.oldTitle !== log.newTitle;

      return `
        <tr>
          <td>${timestamp}</td>
          <td>${escapeHtml(log.itemManageNumber || '-')}</td>
          <td class="log-title-cell" title="${oldTitle}">${oldTitle}</td>
          <td class="log-title-cell${titleChanged ? ' title-changed' : ''}" title="${newTitle}">${newTitle}</td>
          <td>${statusBadge}</td>
          <td>${escapeHtml(log.message || '-')}</td>
        </tr>
      `;
    }).join('');
    
  } else {
    tbody.innerHTML = '<tr><td colspan="6" class="loading">ログがありません</td></tr>';
  }
}

// ==================== 手動実行 ====================
async function runDryRun() {
  const btn = document.getElementById('runDryRunBtn');
  const resultDiv = document.getElementById('runResult');
  const resultMsg = document.getElementById('runResultMessage');
  
  setButtonLoading(btn, true);
  resultDiv.style.display = 'none';
  
  try {
    const result = await apiRequest('runManual');
    
    resultDiv.style.display = 'block';
    resultDiv.className = 'run-result ' + (result.success ? 'success' : 'error');
    resultMsg.textContent = result.message;
    
    if (result.success) {
      showToast('DryRun実行が完了しました', 'success');
      // ログを更新
      loadLogs();
    } else {
      showToast(result.message || '実行に失敗しました', 'error');
    }
    
  } catch (error) {
    resultDiv.style.display = 'block';
    resultDiv.className = 'run-result error';
    resultMsg.textContent = 'サーバーとの通信に失敗しました';
    showToast('実行に失敗しました', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function runNextEventTest() {
  const btn = document.getElementById('runNextEventBtn');
  const resultDiv = document.getElementById('runResult');
  const resultMsg = document.getElementById('runResultMessage');

  setButtonLoading(btn, true);
  resultDiv.style.display = 'none';

  try {
    const result = await apiRequest('runManual', { useNextEvent: true });

    resultDiv.style.display = 'block';
    resultDiv.className = 'run-result ' + (result.success ? 'success' : 'error');
    resultMsg.textContent = result.message;

    if (result.success) {
      showToast('次回イベントでのテスト実行が完了しました', 'success');
      loadLogs();
    } else {
      showToast(result.message || '実行に失敗しました', 'error');
    }

  } catch (error) {
    resultDiv.style.display = 'block';
    resultDiv.className = 'run-result error';
    resultMsg.textContent = 'サーバーとの通信に失敗しました';
    showToast('実行に失敗しました', 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// ==================== タブ制御 ====================
function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      
      // ボタンのアクティブ状態
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // コンテンツの表示
      tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === `tab-${tabId}`) {
          content.classList.add('active');
        }
      });
      
      // タブ固有の処理
      if (tabId === 'logs') {
        loadLogs();
      } else if (tabId === 'items') {
        loadTargetItems();
      } else if (tabId === 'events') {
        loadEvents();
      }
    });
  });
}

// ==================== ユーティリティ ====================
function setButtonLoading(btn, isLoading) {
  const textEl = btn.querySelector('.btn-text');
  const loadingEl = btn.querySelector('.btn-loading');
  
  if (isLoading) {
    btn.disabled = true;
    if (textEl) textEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = 'flex';
  } else {
    btn.disabled = false;
    if (textEl) textEl.style.display = 'inline';
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function formatDate(date) {
  if (!date || isNaN(date)) return '-';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function formatDatetime(date) {
  if (!date || isNaN(date)) return '-';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}`;
}

function escapeHtml(str) {
  if (!str) return '';
  str = String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
