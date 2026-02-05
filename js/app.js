/**
 * 商品名自動修正侍 - Frontend JavaScript
 * GAS Web API との連携
 */

// ==================== 設定 ====================
const API_URL = 'https://script.google.com/macros/s/AKfycbwL_odLRjbnirbyP18mtvOX5Uks7T-Gcc5uuyGlbOYtOjF5Dn6mv9gspiVcqEqK4g1l/exec';

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
      // セッション保存
      Session.save({
        userId: result.data.userId,
        token: result.data.token,
        shopName: result.data.shopName,
        email: result.data.email,
        expiry: result.data.expiry,
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
    
    // フォームに反映
    document.getElementById('settingMode').value = settings.mode || 'TARGET_LIST';
    document.getElementById('settingDryRun').value = String(settings.dryRun);
    document.getElementById('settingMaxItems').value = settings.maxItemsPerRun || 500;
    document.getElementById('settingNotifySlack').checked = settings.notifySlack || false;
    document.getElementById('settingNotifyEmail').checked = settings.notifyEmail || false;
    
    // ステータスカード更新
    document.getElementById('targetItemsCount').textContent = result.data.targetItemsCount + '件';
    document.getElementById('currentMode').textContent = settings.dryRun ? 'DryRun' : '本番';
    
  } else {
    showToast(result.message || '設定の読み込みに失敗しました', 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  
  const settings = {
    mode: document.getElementById('settingMode').value,
    dryRun: document.getElementById('settingDryRun').value === 'true',
    maxItemsPerRun: parseInt(document.getElementById('settingMaxItems').value, 10),
    notifySlack: document.getElementById('settingNotifySlack').checked,
    notifyEmail: document.getElementById('settingNotifyEmail').checked,
  };
  
  const result = await apiRequest('updateSettings', { settings });
  
  if (result.success) {
    showToast('設定を保存しました', 'success');
    loadSettings(); // 再読み込み
  } else {
    showToast(result.message || '設定の保存に失敗しました', 'error');
  }
}

// ==================== イベント ====================
async function loadEvents() {
  const result = await apiRequest('getEvents', { futureOnly: true });
  const tbody = document.querySelector('#eventsTable tbody');
  
  if (result.success && result.data.events.length > 0) {
    const now = new Date();
    let nextEvent = null;
    
    tbody.innerHTML = result.data.events.map(event => {
      const start = new Date(event.startDatetime);
      const end = new Date(event.endDatetime);
      const isActive = now >= start && now <= end;
      const isPast = now > end;
      
      if (!nextEvent && start > now) {
        nextEvent = event;
      }
      
      let statusBadge = '';
      if (isActive) {
        statusBadge = '<span class="badge badge-active">開催中</span>';
      } else if (isPast) {
        statusBadge = '<span class="badge badge-info">終了</span>';
      } else {
        statusBadge = '<span class="badge badge-success">予定</span>';
      }
      
      return `
        <tr>
          <td><strong>${event.eventKey}</strong></td>
          <td>${event.prefixLong}</td>
          <td>${formatDatetime(start)}</td>
          <td>${formatDatetime(end)}</td>
          <td>${statusBadge}</td>
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
    tbody.innerHTML = '<tr><td colspan="5" class="loading">イベントがありません</td></tr>';
    document.getElementById('nextEvent').textContent = '-';
  }
}

// ==================== ログ ====================
async function loadLogs() {
  const result = await apiRequest('getLogs', { limit: 50 });
  const tbody = document.querySelector('#logsTable tbody');
  
  if (result.success && result.data.logs.length > 0) {
    tbody.innerHTML = result.data.logs.map(log => {
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
      
      return `
        <tr>
          <td>${timestamp}</td>
          <td>${log.itemManageNumber || '-'}</td>
          <td>${log.action || '-'}</td>
          <td>${statusBadge}</td>
          <td>${log.message || '-'}</td>
        </tr>
      `;
    }).join('');
    
  } else {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">ログがありません</td></tr>';
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
