(() => {
  // Supabase Authを利用したログイン。固定パスワードはクライアントに置かない。
  const cfg = window.MONITOR_CONFIG || {};
  const AUTH_STORAGE_KEY = 'indoorMonitorSupabaseAuth';
  const loginScreen = document.getElementById('loginScreen');
  const appContent = document.getElementById('appContent');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const logoutButton = document.getElementById('logoutButton');
  let authSession = null;
  let authRefreshPromise = null;

  function readStoredSession() {
    try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function saveSession(session) {
    authSession = session;
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  function authBase() { return String(cfg.supabaseUrl || '').replace(/\/+$/, ''); }
  async function authRequest(path, body) {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('config.jsのSupabase設定を確認してください。');
    const res = await fetch(`${authBase()}/auth/v1/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.msg || data.message || data.error_description || data.error || '';
      if (res.status === 400 || res.status === 401) throw new Error('メールアドレスまたはパスワードを確認してください。');
      throw new Error(message || `認証に失敗しました (HTTP ${res.status})`);
    }
    return data;
  }
  async function getValidSession() {
    if (!authSession) authSession = readStoredSession();
    if (!authSession?.access_token) return null;
    const expiresAt = Number(authSession.expires_at || 0);
    if (expiresAt && expiresAt * 1000 > Date.now() + 60000) return authSession;
    if (!authSession.refresh_token) { saveSession(null); return null; }
    if (!authRefreshPromise) {
      authRefreshPromise = authRequest('token?grant_type=refresh_token', { refresh_token: authSession.refresh_token })
        .then(data => {
          const session = { ...data, expires_at: data.expires_at || Math.floor(Date.now()/1000) + Number(data.expires_in || 3600) };
          saveSession(session); return session;
        })
        .catch(() => { saveSession(null); return null; })
        .finally(() => { authRefreshPromise = null; });
    }
    return authRefreshPromise;
  }
  async function authHeaders(extra = {}) {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください。');
    return { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session.access_token}`, ...extra };
  }

  // 保存済みトークンが有効か、起動時・復帰時にSupabase Authで確認する。
  async function validateSession(session) {
    if (!session?.access_token || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
    try {
      const response = await fetch(`${authBase()}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${session.access_token}`
        },
        cache: 'no-store'
      });
      if (response.status === 401 || response.status === 403) {
        saveSession(null);
        return false;
      }
      // ネットワーク障害時に正しいセッションを勝手に破棄しない。
      return response.ok;
    } catch (_) {
      return true;
    }
  }

  // 同じブラウザの別タブでログアウトした場合も、画面をログイン状態に残さない。
  window.addEventListener('storage', event => {
    if (event.key !== AUTH_STORAGE_KEY) return;
    if (!event.newValue) {
      authSession = null;
      showLogin();
    } else {
      authSession = null; // 次の確認で最新セッションを読み直す
    }
  });
  function showApp() {
    if (loginScreen) loginScreen.hidden = true;
    if (appContent) appContent.hidden = false;
    startMonitorApp();
  }
  function showLogin() {
    if (appContent) appContent.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
    const passwordInput = document.getElementById('loginPassword');
    if (passwordInput) passwordInput.value = '';
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = document.getElementById('loginEmail')?.value.trim() || '';
      const password = document.getElementById('loginPassword')?.value || '';
      const submitButton = loginForm.querySelector('button[type="submit"]');
      if (loginError) loginError.textContent = '';
      if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'ログイン中…'; }
      try {
        const data = await authRequest('token?grant_type=password', { email, password });
        saveSession({ ...data, expires_at: data.expires_at || Math.floor(Date.now()/1000) + Number(data.expires_in || 3600) });
        if (loginError) loginError.textContent = '';
        showApp();
      } catch (error) {
        if (loginError) loginError.textContent = error.message || 'ログインできませんでした。';
      } finally {
        if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'ログイン'; }
      }
    });
  }
  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      const session = await getValidSession();
      try {
        if (session?.access_token) {
          await fetch(`${authBase()}/auth/v1/logout`, {
            method: 'POST', headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` }
          });
        }
      } catch (error) { console.warn('サーバー側ログアウトに失敗しました:', error); }
      saveSession(null);
      showLogin();
    });
  }

  function startMonitorApp() {
    if (window.monitorAppStarted) return;
    window.monitorAppStarted = true;

    const cfg = window.MONITOR_CONFIG || {};
    const $ = id => document.getElementById(id);
    const labels = {
      1: { title: '室温の推移', legend: '室温（℃）', unit: '℃' },
      2: { title: '湿度の推移', legend: '湿度（%）', unit: '%' },
      3: { title: 'ガス・煙の検知履歴', legend: 'ガス・煙（1＝検知／0＝なし）', unit: '' }
    };
    const AUDIO_BUCKET = cfg.supabaseBucket || 'recordings';
    const AUDIO_OBJECT = cfg.latestAudioPath || 'latest.wav';

    let audioLoading = false;
    // Field 6 の「1」を含む ThingSpeak エントリーを呼び出しイベントとして扱う。
    // エントリーID単位で確認状態を保存するため、同じイベントの再取得では赤表示に戻らず、
    // 次の呼び出し（新しい entry_id）で確実に未確認へ戻る。
    const CALL_EVENT_ID_KEY = 'indoorMonitorLatestCallEventId';
    const CALL_ACK_EVENT_ID_KEY = 'indoorMonitorAcknowledgedCallEventId';
    let latestCallEventId = localStorage.getItem(CALL_EVENT_ID_KEY) || '';
    let acknowledgedCallEventId = localStorage.getItem(CALL_ACK_EVENT_ID_KEY) || '';
    let callEventsInitialized = Boolean(latestCallEventId);

    // 自動運転の温度しきい値（変更するボタンでSupabaseへ送信）
    const TEMP_SETTINGS_KEY = 'indoorMonitorTemperatureSettings';
    const DEFAULT_TEMP_SETTINGS = { upper: 28, lower: 26 };
    let temperatureSettings = loadTemperatureSettings();

    function loadTemperatureSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(TEMP_SETTINGS_KEY) || 'null');
        if (
          saved &&
          Number.isFinite(Number(saved.upper)) &&
          Number.isFinite(Number(saved.lower)) &&
          Number(saved.upper) >= 15 &&
          Number(saved.upper) <= 40 &&
          Number(saved.lower) >= 15 &&
          Number(saved.lower) <= 40 &&
          Number(saved.upper) > Number(saved.lower)
        ) {
          return { upper: Number(saved.upper), lower: Number(saved.lower) };
        }
      } catch (error) {
        console.warn('温度設定を読み込めませんでした:', error);
      }
      return { ...DEFAULT_TEMP_SETTINGS };
    }

    function saveTemperatureSettings() {
      try {
        localStorage.setItem(TEMP_SETTINGS_KEY, JSON.stringify(temperatureSettings));
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '未送信の変更があります。実機へ反映するには「変更する」を押してください。';
      } catch (error) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '保存できませんでした。ブラウザの保存設定を確認してください。';
      }
    }

    const DEVICE_SETTINGS_TABLE = cfg.deviceSettingsTable || 'device_settings';

    // parts: 'temp' = 上限/下限温度, 'fan' = 運転モードとON/OFF。
    // 操作に関係する列だけを送る（他の端末が変えた値を古い値で上書きしないため）。
    async function sendDeviceSettings(parts = [], overrides = {}) {
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        throw new Error('config.js のSupabase URL／公開キーを確認してください。');
      }
      const payload = { id: 1, updated_at: new Date().toISOString() };
      if (parts.includes('temp')) {
        payload.upper_temp = temperatureSettings.upper;
        payload.lower_temp = temperatureSettings.lower;
      }
      if (parts.includes('fan')) {
        payload.mode = dashboardSettings.fanMode === 'MANUAL' ? 'manual' : 'auto';
        payload.manual_state = dashboardSettings.fanOn ? 'on' : 'off';
      }
      Object.assign(payload, overrides);
      const base = String(cfg.supabaseUrl).replace(/\/+$/, '');
      const response = await fetch(`${base}/rest/v1/${encodeURIComponent(DEVICE_SETTINGS_TABLE)}?on_conflict=id`, {
        method: 'POST',
        headers: await authHeaders({
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Supabaseへの送信に失敗しました (HTTP ${response.status}) ${detail}`);
      }
      return payload;
    }

    async function sendCurrentDeviceSettings(parts, statusElementId, successMessage) {
      const status = $(statusElementId);
      try {
        if (status) status.textContent = 'Supabaseへ送信しています…';
        await sendDeviceSettings(parts);
        if (status) status.textContent = successMessage;
        logEvent('家電', successMessage);
        return true;
      } catch (error) {
        console.error('機器設定の送信エラー:', error);
        if (status) status.textContent = `送信できませんでした：${error.message}`;
        return false;
      }
    }

    // ===== Supabaseの現在の設定を読み取り、画面に反映する =====
    // 温度の＋／－を押したまま未送信のあいだは、温度だけ上書きしない。
    let temperatureDirty = false;
    let fanSending = false;
    let deviceSyncing = false;

    async function fetchDeviceSettings() {
      const base = String(cfg.supabaseUrl).replace(/\/+$/, '');
      const url = `${base}/rest/v1/${encodeURIComponent(DEVICE_SETTINGS_TABLE)}` +
        '?id=eq.1&select=upper_temp,lower_temp,mode,manual_state,updated_at';
      const response = await fetch(url, { headers: await authHeaders(), cache: 'no-store' });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`設定を取得できません (HTTP ${response.status}) ${detail}`);
      }
      const rows = await response.json();
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    }

    async function syncDeviceSettings({ showStatus = false } = {}) {
      if (deviceSyncing || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return;
      deviceSyncing = true;
      try {
        const row = await fetchDeviceSettings();
        if (!row) return;
        const upper = Number(row.upper_temp);
        const lower = Number(row.lower_temp);
        const validTemp = Number.isFinite(upper) && Number.isFinite(lower) &&
          lower >= 15 && upper <= 40 && upper > lower;
        if (validTemp && !temperatureDirty) {
          temperatureSettings = { upper, lower };
          try { localStorage.setItem(TEMP_SETTINGS_KEY, JSON.stringify(temperatureSettings)); } catch (_) {}
          renderTemperatureSettings();
          if (showStatus && $('temperatureSettingsStatus')) {
            const t = row.updated_at ? new Date(row.updated_at) : null;
            const when = t && !isNaN(t) ? t.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            $('temperatureSettingsStatus').textContent = `現在の実機設定を読み込みました${when ? `（最終更新 ${when}）` : ''}。`;
          }
        }
        if (!fanSending && row.mode) {
          const mode = String(row.mode).toLowerCase() === 'manual' ? 'MANUAL' : 'AUTO';
          const on = String(row.manual_state).toLowerCase() === 'on';
          if (mode !== dashboardSettings.fanMode || on !== dashboardSettings.fanOn) {
            dashboardSettings.fanMode = mode;
            dashboardSettings.fanOn = on;
            saveDashboardSettings();
            renderFanControls();
          }
        }
      } catch (error) {
        console.warn('機器設定の読み込みエラー:', error);
        if (showStatus && $('temperatureSettingsStatus')) {
          $('temperatureSettingsStatus').textContent = `実機の設定を読み込めませんでした：${error.message}`;
        }
      } finally {
        deviceSyncing = false;
      }
    }

    function renderTemperatureSettings() {
      if ($('autoUpperLimit')) $('autoUpperLimit').textContent = String(temperatureSettings.upper);
      if ($('autoLowerLimit')) $('autoLowerLimit').textContent = String(temperatureSettings.lower);
      document.querySelectorAll('[data-temp-target]').forEach(button => {
        const target = button.dataset.tempTarget;
        const delta = Number(button.dataset.tempDelta);
        const next = temperatureSettings[target] + delta;
        button.disabled = next < 15 || next > 40 ||
          (target === 'upper' && next <= temperatureSettings.lower) ||
          (target === 'lower' && next >= temperatureSettings.upper);
      });
    }

    function changeTemperatureSetting(target, delta) {
      const next = temperatureSettings[target] + delta;
      if (!Number.isFinite(next) || next < 15 || next > 40) return;

      if (target === 'upper' && next <= temperatureSettings.lower) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '上限温度は下限温度より高く設定してください。';
        return;
      }
      if (target === 'lower' && next >= temperatureSettings.upper) {
        const status = $('temperatureSettingsStatus');
        if (status) status.textContent = '下限温度は上限温度より低く設定してください。';
        return;
      }

      temperatureSettings[target] = next;
      temperatureDirty = true;
      renderTemperatureSettings();
      saveTemperatureSettings();
    }

    function setupTemperatureSettings() {
      renderTemperatureSettings();
      document.querySelectorAll('[data-temp-target]').forEach(button => {
        button.addEventListener('click', () => {
          changeTemperatureSetting(
            button.dataset.tempTarget,
            Number(button.dataset.tempDelta)
          );
        });
      });

      const applyButton = $('applyTemperatureSettings');
      if (applyButton) {
        applyButton.addEventListener('click', async () => {
          if (temperatureSettings.upper <= temperatureSettings.lower) {
            const status = $('temperatureSettingsStatus');
            if (status) status.textContent = '上限温度は下限温度より高く設定してください。';
            return;
          }
          applyButton.disabled = true;
          try {
            const ok = await sendCurrentDeviceSettings(
              ['temp'],
              'temperatureSettingsStatus',
              'Supabaseに保存しました。Raspberry Piが設定を取得すると反映されます。'
            );
            if (ok) {
              temperatureDirty = false;
              try { localStorage.setItem(TEMP_SETTINGS_KEY, JSON.stringify(temperatureSettings)); } catch (_) {}
            }
          } finally {
            applyButton.disabled = false;
          }
        });
      }

      const resetButton = $('resetTemperatureSettings');
      if (resetButton) {
        resetButton.addEventListener('click', () => {
          temperatureSettings = { ...DEFAULT_TEMP_SETTINGS };
          temperatureDirty = true;
          renderTemperatureSettings();
          saveTemperatureSettings();
        });
      }

      const status = $('temperatureSettingsStatus');
      if (status) status.textContent = '実機の設定を読み込んでいます…';
      syncDeviceSettings({ showStatus: true });
    }



    // 追加ダッシュボード機能は現段階ではWebブラウザ内で動作します。
    const DASHBOARD_KEY = 'indoorMonitorDashboardSettings';
    const EVENTS_KEY = 'indoorMonitorRecentEvents';
    let selectedRangeDays = 1;
    let previousSensorState = {};
    let wakeEvents = [];
    // field3（ガス・煙）は 0＝検知なし／1＝検知 の2値
    const GAS_THRESHOLD = 1;
    const isGasDetected = v => v !== null && v !== undefined && v !== '' && Number(v) >= GAS_THRESHOLD;
    let dashboardSettings = loadDashboardSettings();
    let recentEvents = loadEvents();

    function loadDashboardSettings() {
      const defaults = {
        fanMode: 'AUTO', fanOn: false,
        notifyDoor: true, notifyGas: true, notifyCall: true,
        gasThreshold: GAS_THRESHOLD
      };
      try {
        const saved = JSON.parse(localStorage.getItem(DASHBOARD_KEY) || 'null');
        // ガスセンサーはDO出力（検知=1／未検知=0）。旧版で保存された400などは使わない
        return saved ? { ...defaults, ...saved, gasThreshold: GAS_THRESHOLD } : defaults;
      } catch (_) { return defaults; }
    }

    function saveDashboardSettings() {
      try {
        localStorage.setItem(DASHBOARD_KEY, JSON.stringify(dashboardSettings));
      } catch (error) {
        console.warn('ダッシュボード設定を保存できません:', error);
      }
    }

    function loadEvents() {
      try {
        const value = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]');
        return Array.isArray(value) ? value.slice(0, 30) : [];
      } catch (_) { return []; }
    }

    function logEvent(category, message) {
      const item = {
        time: new Date().toISOString(),
        category: String(category || '情報'),
        message: String(message || '')
      };
      recentEvents.unshift(item);
      recentEvents = recentEvents.slice(0, 30);
      try { localStorage.setItem(EVENTS_KEY, JSON.stringify(recentEvents)); } catch (_) {}
      renderEvents();
    }

    function renderEvents() {
      const list = $('recentEvents');
      if (!list) return;
      list.replaceChildren();
      if (!recentEvents.length) {
        const li = document.createElement('li');
        li.textContent = 'まだ出来事はありません。';
        list.appendChild(li);
        return;
      }
      recentEvents.slice(0, 8).forEach(event => {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'event-time';
        const d = new Date(event.time);
        time.textContent = Number.isNaN(d.getTime())
          ? '--:--'
          : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const body = document.createElement('span');
        const tag = document.createElement('span');
        tag.className = 'event-tag';
        tag.dataset.cat = event.category;
        tag.textContent = event.category;
        body.append(tag, document.createTextNode(event.message));
        li.append(time, body);
        list.appendChild(li);
      });
    }

    function renderFanControls() {
      document.querySelectorAll('[data-fan-mode]').forEach(button => {
        const active = button.dataset.fanMode === dashboardSettings.fanMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      const badge = $('fanStateBadge');
      if (badge) {
        badge.textContent = dashboardSettings.fanOn ? 'ON指示済み' : 'OFF指示済み';
        badge.className = 'pill sm ' + (dashboardSettings.fanOn ? 'warn' : 'idle');
      }
      const autoSection = $('autoSection');
      if (autoSection) autoSection.classList.toggle('off', dashboardSettings.fanMode !== 'AUTO');
      const on = $('fanOnBtn');
      const off = $('fanOffBtn');
      if (on) on.disabled = dashboardSettings.fanMode !== 'MANUAL';
      if (off) off.disabled = dashboardSettings.fanMode !== 'MANUAL';
      const speedUp = $('fanSpeedUpBtn');
      const speedDown = $('fanSpeedDownBtn');
      if (speedUp) speedUp.disabled = dashboardSettings.fanMode !== 'MANUAL';
      if (speedDown) speedDown.disabled = dashboardSettings.fanMode !== 'MANUAL';
      const status = $('fanControlStatus');
      if (status) {
        status.textContent = dashboardSettings.fanMode === 'AUTO'
          ? '自動モードです。温度設定は「変更する」で送信し、モード変更はSupabaseへ送信します。'
          : '手動モードです。ON／OFF／風量UP／DOWNをSupabase経由でRaspberry Piへ送信します。';
      }
    }

    function setupDashboardFeatures() {
      // サーキュレーターの命令をSupabaseへ送信
      document.querySelectorAll('[data-fan-mode]').forEach(button => {
        button.addEventListener('click', async () => {
          const previousMode = dashboardSettings.fanMode;
          dashboardSettings.fanMode = button.dataset.fanMode;
          saveDashboardSettings();
          renderFanControls();
          fanSending = true;
          const ok = await sendCurrentDeviceSettings(
            ['fan'],
            'fanControlStatus',
            `運転モード「${dashboardSettings.fanMode === 'AUTO' ? '自動' : '手動'}」をSupabaseへ送信しました。`
          );
          fanSending = false;
          if (ok) {
            logEvent('家電', '運転モードを' + (dashboardSettings.fanMode === 'AUTO' ? '自動' : '手動') + 'に変更');
          } else {
            dashboardSettings.fanMode = previousMode;
            saveDashboardSettings();
            renderFanControls();
          }
        });
      });
      if ($('fanOnBtn')) $('fanOnBtn').addEventListener('click', async () => {
        if (dashboardSettings.fanMode !== 'MANUAL') return;
        const previous = dashboardSettings.fanOn;
        dashboardSettings.fanOn = true;
        saveDashboardSettings();
        renderFanControls();
        fanSending = true;
        const ok = await sendCurrentDeviceSettings(['fan'], 'fanControlStatus', 'ON命令をSupabaseへ送信しました。');
        fanSending = false;
        if (ok) logEvent('家電', 'サーキュレーター ON命令を送信');
        else { dashboardSettings.fanOn = previous; saveDashboardSettings(); renderFanControls(); }
      });
      if ($('fanOffBtn')) $('fanOffBtn').addEventListener('click', async () => {
        if (dashboardSettings.fanMode !== 'MANUAL') return;
        const previous = dashboardSettings.fanOn;
        dashboardSettings.fanOn = false;
        saveDashboardSettings();
        renderFanControls();
        fanSending = true;
        const ok = await sendCurrentDeviceSettings(['fan'], 'fanControlStatus', 'OFF命令をSupabaseへ送信しました。');
        fanSending = false;
        if (ok) logEvent('家電', 'サーキュレーター OFF命令を送信');
        else { dashboardSettings.fanOn = previous; saveDashboardSettings(); renderFanControls(); }
      });

      // 風量UP／DOWNは1回限りの命令としてSupabaseへ送り、Pi側で赤外線送信する。
      async function sendFanSpeedCommand(command) {
        if (dashboardSettings.fanMode !== 'MANUAL') return;
        const up = $('fanSpeedUpBtn');
        const down = $('fanSpeedDownBtn');
        if (up) up.disabled = true;
        if (down) down.disabled = true;
        const status = $('fanControlStatus');
        if (status) status.textContent = `風量${command === 'UP' ? 'アップ' : 'ダウン'}命令を送信しています…`;
        try {
          // 毎回異なる値にして、同じボタンを連続で押してもPi側が新しい命令と判定できるようにする。
          const commandToken = `${command}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
          await sendDeviceSettings([], { fan_speed_command: commandToken });
          if (status) status.textContent = `風量${command === 'UP' ? 'アップ' : 'ダウン'}命令をSupabaseへ送信しました。Raspberry Piが受信すると赤外線を送信します。`;
          logEvent('家電', `サーキュレーター 風量${command === 'UP' ? 'アップ' : 'ダウン'}命令を送信`);
        } catch (error) {
          if (status) status.textContent = `風量操作を送信できませんでした: ${error.message}`;
        } finally {
          renderFanControls();
        }
      }
      if ($('fanSpeedUpBtn')) $('fanSpeedUpBtn').addEventListener('click', () => sendFanSpeedCommand('UP'));
      if ($('fanSpeedDownBtn')) $('fanSpeedDownBtn').addEventListener('click', () => sendFanSpeedCommand('DOWN'));

      // 通知スイッチの保存
      ['notifyDoor', 'notifyGas', 'notifyCall'].forEach(id => {
        const input = $(id);
        if (!input) return;
        input.checked = Boolean(dashboardSettings[id]);
        input.addEventListener('change', async () => {
          dashboardSettings[id] = input.checked;
          saveDashboardSettings();
          syncServiceWorkerPreferences();
          const status = $('notificationStatus');
          if (input.checked) {
            try {
              await subscribePushNotifications();
              if (status) status.textContent = '通知を登録しました。アプリを閉じていても、サーバー設定完了後はプッシュ通知を受信できます。';
            } catch (error) {
              const permission = ('Notification' in window) ? Notification.permission : 'unsupported';
              if (status) status.textContent = '画面内通知設定は保存しましたが、バックグラウンド通知の登録に失敗しました: ' + error.message;
            }
          } else {
            try { await syncPushPreferences(); } catch (error) { console.warn(error); }
            if (status) status.textContent = 'この種類の通知をOFFにしました。';
          }
        });
      });

      if ($('testNotificationBtn')) $('testNotificationBtn').addEventListener('click', async () => {
        const status = $('notificationStatus');
        if (!('Notification' in window)) {
          if (status) status.textContent = 'このブラウザは通知APIに対応していません。';
          return;
        }
        try {
          const permission = await ensureNotificationPermission();
          if (permission === 'granted') {
            const reg = await registerPushWorker();
            await reg.showNotification('室内監視システム', { body: 'テスト通知です。', icon: './icon.svg' });
            try { await subscribePushNotifications(); } catch (e) { console.warn('Push登録は未完了:', e); }
            if (status) status.textContent = '端末内テスト通知を表示しました。アプリ終了中の通知には、READMEのサーバー設定も必要です。';
            logEvent('通知', 'テスト通知を実行');
          } else if (status) {
            status.textContent = '通知は許可されていません。ブラウザのサイト設定を確認してください。';
          }
        } catch (error) {
          if (status) status.textContent = '通知を表示できませんでした: ' + error.message;
        }
      });

      // 録音を再生できたら、その呼び出しを確認済みにする。
      if ($('playCallAudio')) $('playCallAudio').addEventListener('click', async () => {
        const player = $('latestAudio');
        if (!player || !player.src) {
          if ($('audioStatus')) $('audioStatus').textContent = '呼び出し録音を取得中です。少し待ってから再生してください。';
          return;
        }
        try {
          await player.play();
          if (latestCallEventId) {
            acknowledgedCallEventId = latestCallEventId;
            localStorage.setItem(CALL_ACK_EVENT_ID_KEY, acknowledgedCallEventId);
          }
          renderCallAlert();
          logEvent('呼び出し', '録音を再生して確認済みにした');
        } catch (error) {
          if ($('audioStatus')) $('audioStatus').textContent = '再生できませんでした。再生ボタンを押してください。';
        }
      });

      if ($('clearEventsBtn')) $('clearEventsBtn').addEventListener('click', () => {
        recentEvents = [];
        try { localStorage.removeItem(EVENTS_KEY); } catch (_) {}
        renderEvents();
      });

      // グラフ期間切替
      document.querySelectorAll('[data-range]').forEach(button => {
        button.addEventListener('click', () => {
          selectedRangeDays = Number(button.dataset.range) || 1;
          document.querySelectorAll('[data-range]').forEach(item => {
            const active = item === button;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
          });
          drawChart();
          loadChartHistory(true).then(drawChart).catch(e => console.warn('グラフ履歴取得エラー:', e));
        });
      });

      renderFanControls();
      renderEvents();
      renderWakeHistory();
    }

    function renderWakeHistory() {
      const current = $('wakeCurrentStatus');
      const summary = $('wakeSummary');
      const list = $('wakeHistory');
    
      if (current) {
        const bedValue = latestFeed?.field5;
    
        if (bedValue === null || bedValue === undefined || bedValue === '') {
          current.textContent = '在床状態を確認できません';
        } else {
          current.textContent = Number(bedValue) >= 1
            ? '在床あり'
            : '離床中';
        }
        current.className = 'pill ' + ((bedValue === null || bedValue === undefined || bedValue === '')
          ? 'idle' : (Number(bedValue) >= 1 ? 'info' : 'ok'));
      }
    
      if (summary) {
        summary.textContent = 'センサーの最新状態：' +
          (($('updatedAt')?.textContent || '').replace('最終更新：', '') || '--');
      }
    
      if (!list) return;
    
      list.replaceChildren();
    
      if (!wakeEvents.length) {
        const li = document.createElement('li');
        li.textContent = 'ページを開いてからの在床状態の変化がここに表示されます。';
        list.appendChild(li);
        return;
      }
    
      wakeEvents.slice(0, 5).forEach(event => {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = event.time;
    
        const body = document.createElement('span');
        body.textContent = event.message;
    
        li.append(time, body);
        list.appendChild(li);
      });
    }

    function trackSensorEvents(feed) {
      if (!feed) return;
      const current = {
        door: Number(feed.field4) >= 1,
        bed: Number(feed.field5) >= 1,
        gas: Number(feed.field3)
      };
      if (previousSensorState.door !== undefined && current.door !== previousSensorState.door) {
        const message = current.door ? 'ドアが開きました' : 'ドアが閉まりました';
        logEvent('ドア', message);
        if (dashboardSettings.notifyDoor) showBrowserNotification('ドア状態', message);
      }
      if (previousSensorState.bed !== undefined && current.bed !== previousSensorState.bed) {
        const message = current.bed ? '在床を検知しました' : '離床を検知しました';
        wakeEvents.unshift({
          time: new Date().toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'}),
          message
        });
        wakeEvents = wakeEvents.slice(0, 10);
        renderWakeHistory();
        logEvent('ベッド', message);
      }
      if (Number.isFinite(current.gas) && Number.isFinite(previousSensorState.gas) &&
          current.gas >= GAS_THRESHOLD && previousSensorState.gas < GAS_THRESHOLD) {
        logEvent('ガス', 'ガス・煙を検知しました');
        if (dashboardSettings.notifyGas) showBrowserNotification('ガス・煙を検知', 'ガス・煙を検知しました。現地を確認してください。');
      }
      if (Number.isFinite(current.gas) && Number.isFinite(previousSensorState.gas) &&
          current.gas < GAS_THRESHOLD && previousSensorState.gas >= GAS_THRESHOLD) {
        logEvent('ガス', 'ガス・煙の検知がなくなりました');
      }
      previousSensorState = current;
      renderWakeHistory();
    }

    async function registerPushWorker() {
      if (!('serviceWorker' in navigator)) throw new Error('このブラウザはService Worker非対応です。');
      return navigator.serviceWorker.register('./service-worker.js');
    }

    // 通知設定をService Workerにも保存し、アプリを閉じた状態のPush通知にも反映する。
    async function syncServiceWorkerPreferences() {
      if (!('serviceWorker' in navigator)) return;
      try {
        const registration = await navigator.serviceWorker.getRegistration('./') || await registerPushWorker();
        const worker = registration.active || registration.waiting || registration.installing;
        if (worker) worker.postMessage({
          type: 'SET_NOTIFICATION_PREFERENCES',
          preferences: {
            door: !!dashboardSettings.notifyDoor,
            gas: !!dashboardSettings.notifyGas,
            call: !!dashboardSettings.notifyCall
          }
        });
      } catch (error) { console.warn('Service Workerへの通知設定同期に失敗:', error); }
    }

    function decodeVapidKey(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
    }

    async function subscribePushNotifications() {
      if (!cfg.pushFunctionUrl || !cfg.vapidPublicKey || cfg.vapidPublicKey.includes('PASTE_')) {
        throw new Error('プッシュ通知のサーバー設定が未完了です。READMEの設定手順を実施してください。');
      }
      const permission = await ensureNotificationPermission();
      if (permission !== 'granted') throw new Error('ブラウザの通知許可が必要です。');
      const registration = await registerPushWorker();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(cfg.vapidPublicKey)
        });
      }
      const response = await fetch(cfg.pushFunctionUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey, 'Authorization': `Bearer ${cfg.supabaseAnonKey}` },
        body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON(), preferences: { door: !!dashboardSettings.notifyDoor, gas: !!dashboardSettings.notifyGas, call: !!dashboardSettings.notifyCall }, gasThreshold: GAS_THRESHOLD })
      });
      if (!response.ok) throw new Error('通知登録に失敗しました (HTTP ' + response.status + ')');
      return true;
    }

    async function syncPushPreferences() {
      if (!cfg.pushFunctionUrl || !cfg.vapidPublicKey || cfg.vapidPublicKey.includes('PASTE_')) return;
      const registration = await navigator.serviceWorker.getRegistration('./');
      const subscription = registration && await registration.pushManager.getSubscription();
      if (!subscription) return;
      const response = await fetch(cfg.pushFunctionUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': cfg.supabaseAnonKey, 'Authorization': `Bearer ${cfg.supabaseAnonKey}` },
        body: JSON.stringify({ action: 'subscribe', subscription: subscription.toJSON(), preferences: { door: !!dashboardSettings.notifyDoor, gas: !!dashboardSettings.notifyGas, call: !!dashboardSettings.notifyCall }, gasThreshold: GAS_THRESHOLD })
      });
      if (!response.ok) throw new Error('通知設定の同期に失敗しました');
    }

    async function ensureNotificationPermission() {
      if (!('Notification' in window)) return 'unsupported';
      if (Notification.permission === 'default') {
        try { return await Notification.requestPermission(); }
        catch (_) { return Notification.permission; }
      }
      return Notification.permission;
    }

    function showBrowserNotification(title, body) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      try { new Notification(title, { body, tag: 'indoor-monitor-' + title }); } catch (_) {}
    }

    function formatAudioDate(value) {
      if (!value) return '';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP');
    }

    // 固定ファイル latest.wav の署名付きURLを取得し、音声データ自体もキャッシュせず読み込む
    let currentAudioObjectUrl = null;
    let currentAudioHash = null;

    async function refreshLatestAudio() {
      if (audioLoading) return;

      const player = $('latestAudio');
      if (!player) return;

      if (
        !cfg.supabaseUrl ||
        !cfg.supabaseAnonKey ||
        String(cfg.supabaseUrl).includes('YOUR_') ||
        String(cfg.supabaseAnonKey).includes('YOUR_')
      ) {
        console.warn('呼び出し録音の再生には config.js のSupabase設定が必要です。');
        if ($('audioStatus')) $('audioStatus').textContent = 'Supabaseの設定を確認してください。';
        return;
      }

      audioLoading = true;
      const status = $('audioStatus');

      try {
        const base = String(cfg.supabaseUrl).replace(/\/+$/, '');
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const encodedPath = AUDIO_OBJECT
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const signUrl =
          `${base}/storage/v1/object/sign/` +
          `${encodeURIComponent(AUDIO_BUCKET)}/${encodedPath}`;

        const signRes = await fetch(signUrl, {
          method: 'POST',
          headers,
          cache: 'no-store',
          body: JSON.stringify({ expiresIn: 600 })
        });

        if (!signRes.ok) {
          const detail = await signRes.text();
          console.error('Supabase署名付きURL取得エラー', {
            status: signRes.status,
            response: detail
          });
          if (signRes.status === 404) {
            throw new Error(`録音ファイルが見つかりません。${AUDIO_BUCKET}/${AUDIO_OBJECT} を確認してください。`);
          }
          if (signRes.status === 400 || signRes.status === 403) {
            throw new Error(`録音へのアクセスに失敗しました (HTTP ${signRes.status})。Storageの権限設定を確認してください。`);
          }
          throw new Error(`再生URLを取得できません (HTTP ${signRes.status})。`);
        }

        const signed = await signRes.json();
        const signedPath = signed.signedURL || signed.signedUrl;
        if (!signedPath) {
          throw new Error('Supabaseから署名付き再生URLが返されませんでした。');
        }

        let audioUrl;
        if (/^https?:\/\//i.test(signedPath)) {
          audioUrl = signedPath;
        } else if (signedPath.startsWith('/storage/v1/')) {
          audioUrl = `${base}${signedPath}`;
        } else {
          audioUrl = `${base}/storage/v1/${signedPath.replace(/^\/+/, '')}`;
        }

        // 署名付きURLだけでなく音声本体を取得し直す。cache:no-storeで古い録音の再利用を防ぐ。
        const audioRes = await fetch(audioUrl, {
          method: 'GET',
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!audioRes.ok) {
          throw new Error(`録音データを取得できません (HTTP ${audioRes.status})。`);
        }

        const audioBlob = await audioRes.blob();
        if (!audioBlob.size) throw new Error('取得した録音データが空でした。');

        // latest.wav が前回と異なる内容なら、新しい呼び出しとして確認状態を解除する。
        const audioBytes = await audioBlob.arrayBuffer();
        let audioHash;
        if (window.crypto && window.crypto.subtle) {
          const digest = await window.crypto.subtle.digest('SHA-256', audioBytes);
          audioHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
          audioHash = `${audioBlob.size}:${audioBlob.type}:${audioBlob.lastModified || 0}`;
        }
        // 録音ファイルは再取得しますが、確認状態の切り替えは ThingSpeak の
        // Field 6 の新しい entry_id を基準に行います（固定 latest.wav の更新時刻だけには依存しません）。
        currentAudioHash = audioHash;

        const nextObjectUrl = URL.createObjectURL(audioBlob);
        const previousObjectUrl = currentAudioObjectUrl;
        player.src = nextObjectUrl;
        player.dataset.signedAt = String(Date.now());
        player.load();
        player.hidden = true;
        currentAudioObjectUrl = nextObjectUrl;

        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
        if (status) status.textContent = `呼び出し録音を取得しました（${new Date().toLocaleTimeString('ja-JP')}）。`;
      } catch (e) {
        console.error('呼び出し録音を取得できません:', e.message || e);
        // 取得失敗時も、以前に取得できた録音は消さずに残す
        if (status) status.textContent = `録音を更新できませんでした。${e.message || '通信状態を確認してください。'}`;
      } finally {
        audioLoading = false;
      }
    }

    let selectedField = '1';
    let latestFeed = null;
    let feeds = [];
    let loading = false;

    const validConfig = () =>
      cfg.channelId &&
      cfg.readApiKey &&
      !String(cfg.channelId).includes('YOUR_') &&
      !String(cfg.readApiKey).includes('YOUR_');

    function setConnection(ok, text) {
      const dot = $('connectionDot');
      const label = $('connectionText');
      if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'bad');
      if (label) label.textContent = text;
    }

    function setAlert(kind, title, detail, icon) {
      const el = $('alertCard');
      if (!el) return;
      el.className = 'alert-card' + (kind ? ' ' + kind : '');
      if ($('alertTitle')) $('alertTitle').textContent = title;
      if ($('alertDetail')) $('alertDetail').textContent = detail;
      if ($('alertIcon')) $('alertIcon').textContent = icon;
    }

    function fmtNum(v, digits = 1) {
      if (v === null || v === undefined || v === '') return '--';
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : '--';
    }

    function statusText(v, yes, no) {
      if (v === null || v === undefined || v === '') return '--';
      return Number(v) >= 1 ? yes : no;
    }

    function renderLatest(f) {
      if (!f) return;
      if ($('temperature')) $('temperature').textContent = fmtNum(f.field1);
      if ($('humidity')) $('humidity').textContent = fmtNum(f.field2);
      if ($('gas')) {
        const noData = f.field3 === null || f.field3 === undefined || f.field3 === '' || !Number.isFinite(Number(f.field3));
        $('gas').textContent = noData ? '--' : (isGasDetected(f.field3) ? '検知あり' : '検知なし');
        $('gas').className = 'pill ' + (noData ? 'idle' : (isGasDetected(f.field3) ? 'danger' : 'ok'));
        const card = $('gasCard');
        if (card) card.classList.toggle('alarm', !noData && isGasDetected(f.field3));
      }
      if ($('door')) {
        $('door').textContent = statusText(f.field4, '開', '閉');
        $('door').className = 'pill ' + (f.field4 === null || f.field4 === undefined || f.field4 === ''
          ? 'idle' : (Number(f.field4) >= 1 ? 'warn' : 'info'));
      }
      if ($('bed')) $('bed').textContent = statusText(f.field5, '在床あり', '在床なし');

      // Field 6 は個別の呼び出しイベントとして履歴から判定する。
      // 最新の測定データ行で Field 6 が空欄でも、呼び出し状態を解除しない。

      if (f.created_at) {
        const d = new Date(f.created_at);
        if ($('updatedAt')) {
          $('updatedAt').textContent =
            '最終更新：' +
            (Number.isNaN(d.getTime()) ? f.created_at : d.toLocaleString('ja-JP'));
        }

        const age = Date.now() - d.getTime();
        if (Number.isFinite(age) && age > 5 * 60 * 1000) {
          setAlert(
            'warning',
            'データの更新が遅れています',
            '最後の記録から5分以上経過しています。Raspberry Piとネットワークを確認してください。',
            '!'
          );
        } else {
          setAlert(
            '',
            '監視データを受信しています',
            '以下はクラウドに保存された最新の測定値です。',
            '✓'
          );
        }
      }

      if (isGasDetected(f.field3)) {
        setAlert('error', 'ガス・煙を検知しています', 'ガス・煙センサーが反応しています。すぐに現地を確認してください。', '!');
      } else if (f.field1 !== '' && Number(f.field1) >= 30) {
        setAlert(
          'warning',
          '室温が高くなっています',
          '室温が30℃以上です。現地の状況を確認してください。',
          '!'
        );
      }
    }


    function renderCallAlert() {
      const card = $('callAlert');
      if (!card) return;
      const hasCall = Boolean(latestCallEventId);
      const isAcknowledged = hasCall && acknowledgedCallEventId === latestCallEventId;
      card.classList.toggle('active', hasCall && !isAcknowledged);
      card.classList.toggle('acknowledged', hasCall && isAcknowledged);
      if ($('callAlertTitle')) {
        $('callAlertTitle').textContent = !hasCall ? '呼び出しはありません' :
          (isAcknowledged ? '呼び出しを確認済み' : '呼び出しがあります');
      }
      if ($('callAlertDetail')) {
        $('callAlertDetail').textContent = !hasCall
          ? '呼び出しボタンの通知状態を表示します。'
          : (isAcknowledged
            ? '録音を再生しました。新しい呼び出しが届くと再び通知します。'
            : '新しい呼び出しを受信しました。録音を再生して状況を確認してください。');
      }
      if ($('callAlertIcon')) $('callAlertIcon').textContent = '!';
    }

    function processCallEvents(historyFeeds) {
      // Field 6 が 1 以上の行のうち、entry_id が最も新しいものを呼び出しイベントとする。
      // 通常の測定データ行で Field 6 が空欄でも、直近の呼び出しを維持する。
      let eventFeed = null;
      for (const feed of (Array.isArray(historyFeeds) ? historyFeeds : [])) {
        if (feed.field6 !== undefined && feed.field6 !== null && feed.field6 !== '' && Number(feed.field6) >= 1) {
          if (!eventFeed || Number(feed.entry_id || 0) >= Number(eventFeed.entry_id || 0)) eventFeed = feed;
        }
      }
      if (eventFeed) {
        const eventId = String(eventFeed.entry_id || eventFeed.created_at || '');
        if (eventId && eventId !== latestCallEventId) {
          const isNewDuringThisSession = callEventsInitialized;
          latestCallEventId = eventId;
          callEventsInitialized = true;
          localStorage.setItem(CALL_EVENT_ID_KEY, latestCallEventId);
          logEvent('呼び出し', '新しい呼び出しを受信しました（ThingSpeak entry ' + latestCallEventId + '）');
          // 初回読み込み時の過去イベントでは通知せず、監視開始後に届いた新規イベントだけ通知する。
          if (isNewDuringThisSession && dashboardSettings.notifyCall) {
            //showBrowserNotification('呼び出し通知', '新しい呼び出しがありました。室内監視画面で録音を再生して確認してください。');
          }
        }
      }
      renderCallAlert();
    }

    async function api(path) {
      const url =
        `https://api.thingspeak.com/channels/${encodeURIComponent(cfg.channelId)}/${path}` +
        `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(cfg.readApiKey)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('クラウドAPIエラー: HTTP ' + res.status);
      return res.json();
    }

    // ===== グラフ用の履歴取得 =====
    // ThingSpeakは1回のリクエストで最大8000件まで。期間内を end パラメータで
    // さかのぼりながら複数回取得してつなげる（20秒間隔なら24時間≒4320件、30日≒13万件）。
    const CHART_PAGE_SIZE = 8000;
    const CHART_MAX_PAGES = 20;               // 安全上限（8000×20=16万件）
    const CHART_FULL_RELOAD_MS = 10 * 60 * 1000;
    let chartFeeds = [];
    let chartFeedsDays = 0;
    let chartFeedsLoadedAt = 0;
    let chartLoading = null;

    function tsDate(d) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}%20${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    }

    async function fetchRange(days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const start = tsDate(new Date(cutoff));
      let end = null;
      let all = [];
      for (let page = 0; page < CHART_MAX_PAGES; page++) {
        const q = `feeds.json?results=${CHART_PAGE_SIZE}&timezone=Etc/UTC&start=${start}` + (end ? `&end=${end}` : '');
        const res = await api(q);
        const chunk = Array.isArray(res.feeds) ? res.feeds : [];
        if (!chunk.length) break;
        const known = new Set(all.map(f => f.entry_id));
        all = chunk.filter(f => !known.has(f.entry_id)).concat(all);
        if (chunk.length < CHART_PAGE_SIZE) break;
        const oldest = new Date(chunk[0].created_at).getTime();
        if (!Number.isFinite(oldest) || oldest <= cutoff) break;
        end = tsDate(new Date(oldest - 1000));
      }
      return all;
    }

    async function loadChartHistory(force = false) {
      const days = selectedRangeDays;
      const fresh = chartFeedsDays === days && Date.now() - chartFeedsLoadedAt < CHART_FULL_RELOAD_MS;
      if (!force && fresh) {
        // 定期更新では、通常更新で取れた新しい分だけ追記する
        const lastId = chartFeeds.length ? chartFeeds[chartFeeds.length - 1].entry_id : 0;
        const add = feeds.filter(f => f.entry_id > lastId);
        if (add.length) chartFeeds = chartFeeds.concat(add);
        return;
      }
      if (chartLoading && chartLoading.days === days) return chartLoading.promise;
      if ($('chartRange')) $('chartRange').textContent = '読み込み中…';
      const promise = fetchRange(days).then(list => {
        if (selectedRangeDays !== days) return;   // 途中で期間が切り替わった
        chartFeeds = list;
        chartFeedsDays = days;
        chartFeedsLoadedAt = Date.now();
      }).finally(() => { if (chartLoading && chartLoading.promise === promise) chartLoading = null; });
      chartLoading = { days, promise };
      return promise;
    }

    // 描画点数を画面幅程度に間引く（区間ごとの平均）
    function downsample(list, field, maxPoints, useMax = false) {
      if (list.length <= maxPoints) return list;
      const size = list.length / maxPoints;
      const out = [];
      for (let i = 0; i < maxPoints; i++) {
        const seg = list.slice(Math.floor(i * size), Math.floor((i + 1) * size));
        if (!seg.length) continue;
        const avg = useMax
          ? Math.max(...seg.map(f => Number(f[field])))
          : seg.reduce((a, f) => a + Number(f[field]), 0) / seg.length;
        const mid = seg[Math.floor(seg.length / 2)];
        out.push({ ...mid, [field]: avg });
      }
      return out;
    }

    async function refresh() {
      if (loading) return;

      if (!validConfig()) {
        setConnection(false, '初期設定が必要です');
        setAlert(
          'warning',
          'クラウド設定が未完了です',
          'config.js にチャンネルIDと読み取りAPIキーを設定してください。',
          '!'
        );
        if ($('chartEmpty')) {
          $('chartEmpty').textContent = 'config.js の設定後に履歴が表示されます。';
        }
        return;
      }

      loading = true;
      try {
        const [last, history] = await Promise.all([
          api('feeds/last.json'),
          api(`feeds.json?results=${Math.min(8000, Math.max(1, Number(cfg.historyResults) || 100))}`)
        ]);

        if (last && last.created_at) {
          latestFeed = last;
          renderLatest(last);
          trackSensorEvents(last);
        }
        feeds = Array.isArray(history.feeds) ? history.feeds : [];
        processCallEvents(feeds);

        if (!latestFeed && feeds.length) {
          latestFeed = feeds[feeds.length - 1];
          renderLatest(latestFeed);
          trackSensorEvents(latestFeed);
        }
        if (!latestFeed) {
          throw new Error('データがまだありません。Piから最初のデータを送信してください。');
        }

        setConnection(true, 'クラウド接続中');
        try {
          await loadChartHistory();
        } catch (e) {
          console.warn('グラフ履歴取得エラー:', e);
        }
        drawChart();
      } catch (e) {
        setConnection(false, '接続できません');
        if (!latestFeed) {
          setAlert(
            'error',
            'データを取得できません',
            e.message + ' チャンネルID・Read API Key・インターネット接続を確認してください。',
            '×'
          );
        }
        if ($('chartEmpty')) {
          $('chartEmpty').textContent = 'データを取得できません。設定と通信を確認してください。';
        }
      } finally {
        loading = false;
      }
    }

    // 0時ちょうど（端末のタイムゾーン）を返す
    function startOfDay(t) {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    // 7日・30日用：1日ごとの平均値。データのない日は value=null。
    function buildDailyAverages(list, field, days, useMax = false) {
      const today = startOfDay(Date.now());
      const slots = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        slots.push({ date: d, sum: 0, count: 0, value: null });
      }
      const first = slots[0].date.getTime();
      list.forEach(f => {
        const t = new Date(f.created_at);
        if (t.getTime() < first) return;
        const day = startOfDay(t).getTime();
        // 夏時間のない日本では (day-first)/24h で日数が出る。念のため丸める
        const idx = Math.round((day - first) / 86400000);
        if (idx < 0 || idx >= slots.length) return;
        const v = Number(f[field]);
        slots[idx].sum = useMax ? Math.max(slots[idx].count ? slots[idx].sum : v, v) : slots[idx].sum + v;
        slots[idx].count += 1;
      });
      slots.forEach(s => { if (s.count) s.value = useMax ? s.sum : s.sum / s.count; });
      return slots;
    }

    function drawChart() {
      const canvas = $('historyChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const field = 'field' + selectedField;
      const isGas = String(selectedField) === '3';
      const isTemp = String(selectedField) === '1';
      const daily = selectedRangeDays > 1;
      const now = Date.now();
      const rangeStart = daily
        ? (() => { const d = startOfDay(now); d.setDate(d.getDate() - (selectedRangeDays - 1)); return d.getTime(); })()
        : now - 24 * 60 * 60 * 1000;

      const source = chartFeedsDays === selectedRangeDays && chartFeeds.length ? chartFeeds : feeds;
      const filtered = source.filter(f =>
        f[field] !== null && f[field] !== '' &&
        Number.isFinite(Number(f[field])) &&
        f.created_at && new Date(f.created_at).getTime() >= rangeStart
      );
      const totalCount = filtered.length;

      // 描画する点 {t: 時刻(ms), v: 値}。v=null は欠測（線を切る）
      // 温度・湿度は1日の平均、ガスは「その日に1回でも検知したか」（最大値）
      let points;
      let slots = null;
      if (daily) {
        slots = buildDailyAverages(filtered, field, selectedRangeDays, isGas);
        points = slots.map(s => ({ t: s.date.getTime(), v: s.value }));
      } else {
        const ds = downsample(filtered, field, Math.max(100, Math.round(w)), isGas);
        points = [];
        ds.forEach((f, i) => {
          const t = new Date(f.created_at).getTime();
          // 15分以上データが空いたら線を切る
          if (i && t - points[points.length - 1].t > 15 * 60 * 1000) points.push({ t, v: null });
          points.push({ t, v: Number(f[field]) });
        });
      }
      const valued = points.filter(p => p.v !== null);

      const meta = labels[selectedField];
      const lineColor = { 1: '#f59f00', 2: '#2f6fdb', 3: '#149687' }[selectedField] || '#2f6fdb';
      if ($('legendSwatch')) $('legendSwatch').style.background = lineColor;
      if ($('chartTitle')) $('chartTitle').textContent = meta.title;
      if ($('legendText')) {
        $('legendText').textContent = !daily ? meta.legend
          : isGas ? `${meta.legend}・1日ごと（1回でも検知した日＝検知）`
          : `${meta.legend}・1日ごとの平均`;
      }
      if ($('chartRange')) {
        $('chartRange').textContent = !valued.length ? '記録なし'
          : daily ? `${selectedRangeDays}日・${isGas ? '日ごと' : '日平均'}（${valued.length}日分／${totalCount}件）`
          : `24時間・${totalCount}件`;
      }
      if ($('chartEmpty')) $('chartEmpty').style.display = valued.length ? 'none' : 'grid';
      if (!valued.length) return;

      // ---- 横軸の配置 ----
      const FONT = '13px "Noto Sans JP", system-ui, sans-serif';
      const FONT_S = '12px "Noto Sans JP", system-ui, sans-serif';
      ctx.font = FONT_S;
      const padL = 48, padR = 16, padT = 18;
      const cw = w - padL - padR;
      const step = daily ? cw / selectedRangeDays : 0;
      // 日付ラベルが横に並ばないときは縦向きにする
      const rotate = daily && step < ctx.measureText('12/31').width + 8;
      const pad = { l: padL, r: padR, t: padT, b: rotate ? 50 : 34 };
      const ch = h - pad.t - pad.b;
      // 日ごとの点は各日の枠の中央に置く
      const xOf = daily
        ? (i => pad.l + step * (i + 0.5))
        : (t => pad.l + cw * (t - rangeStart) / (now - rangeStart));

      // ---- 縦軸 ----
      const vals = valued.map(p => p.v);
      let min = Math.min(...vals);
      let max = Math.max(...vals);
      if (min === max) { min -= 1; max += 1; }
      const margin = (max - min) * 0.12;
      min -= margin;
      max += margin;
      if (isGas) { min = -0.15; max = 1.15; }
      // 温度グラフでは自動運転の上限温度が範囲に入るように調整
      if (isTemp && Number.isFinite(temperatureSettings.upper)) {
        if (temperatureSettings.upper > max) max = temperatureSettings.upper + margin;
        if (temperatureSettings.upper < min) min = temperatureSettings.upper - margin;
      }
      const yOf = v => pad.t + ch * (max - v) / (max - min);

      ctx.font = FONT;
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#eceef1';
      ctx.fillStyle = '#6b6f76';
      if (isGas) {
        [[1, '検知'], [0, 'なし']].forEach(([v, text]) => {
          const y = yOf(v);
          ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(text, pad.l - 7, y);
        });
      } else {
        for (let i = 0; i < 5; i++) {
          const y = pad.t + ch * i / 4;
          ctx.beginPath();
          ctx.moveTo(pad.l, y);
          ctx.lineTo(w - pad.r, y);
          ctx.stroke();
          const v = max - (max - min) * i / 4;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(v.toFixed(1), pad.l - 7, y);
        }
      }

      // ---- 横軸の目盛りとラベル ----
      ctx.font = FONT_S;
      ctx.strokeStyle = '#f1f3f5';
      if (daily) {
        // すべての日付を表示。1日あたり11px未満のときだけ1日おきにラベルを付ける（目盛りは毎日）
        const every = rotate && step < 11 ? 2 : 1;
        slots.forEach((sl, i) => {
          const x = xOf(i);
          ctx.beginPath();
          ctx.moveTo(x, pad.t);
          ctx.lineTo(x, pad.t + ch);
          ctx.stroke();
          if ((slots.length - 1 - i) % every) return;   // 今日は必ず表示
          const label = `${sl.date.getMonth() + 1}/${sl.date.getDate()}`;
          const dow = sl.date.getDay();
          ctx.fillStyle = dow === 0 ? '#e03131' : dow === 6 ? '#2f6fdb' : '#6b6f76';
          if (rotate) {
            ctx.save();
            ctx.translate(x, pad.t + ch + 6);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, 0, 0);
            ctx.restore();
          } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(label, x, pad.t + ch + 9);
          }
        });
      } else {
        // 24時間：3時間ごとの時刻（0時は日付）
        const tick = new Date(rangeStart);
        tick.setMinutes(0, 0, 0);
        if (tick.getTime() < rangeStart) tick.setHours(tick.getHours() + 1);
        while (tick.getHours() % 3) tick.setHours(tick.getHours() + 1);
        ctx.fillStyle = '#6b6f76';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let t = tick.getTime(); t <= now; t += 3 * 60 * 60 * 1000) {
          const x = xOf(t);
          ctx.beginPath();
          ctx.moveTo(x, pad.t);
          ctx.lineTo(x, pad.t + ch);
          ctx.stroke();
          const d = new Date(t);
          ctx.fillText(d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getHours()}時`, x, pad.t + ch + 9);
        }
      }

      // ---- 上限温度の点線 ----
      if (isTemp && Number.isFinite(temperatureSettings.upper)) {
        const yu = yOf(temperatureSettings.upper);
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(245,159,0,.7)';
        ctx.beginPath();
        ctx.moveTo(pad.l, yu);
        ctx.lineTo(w - pad.r, yu);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#c77700';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`上限 ${temperatureSettings.upper}℃`, pad.l + 6, yu - 4);
      }

      // ---- 折れ線（欠測で切る。ガスは階段状） ----
      const pos = points.map((p, i) => ({ x: daily ? xOf(i) : xOf(p.t), y: p.v === null ? null : yOf(p.v) }));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let prev = null;
      pos.forEach(p => {
        if (p.y === null) { prev = null; return; }
        if (!prev) ctx.moveTo(p.x, p.y);
        else {
          if (isGas) ctx.lineTo(p.x, prev.y);
          ctx.lineTo(p.x, p.y);
        }
        prev = p;
      });
      // ガスの日ごと表示は線でつながず、点（検知＝赤）だけで示す
      if (!(daily && isGas)) ctx.stroke();

      // 点：日ごと表示では毎日、24時間は点が少ないときだけ
      if (daily || (valued.length < 60 && !isGas)) {
        pos.forEach((p, i) => {
          if (p.y === null) return;
          ctx.beginPath();
          const big = daily && (selectedRangeDays <= 7 || (isGas && points[i].v >= 1));
          ctx.arc(p.x, p.y, big ? 5.5 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = isGas && points[i].v >= 1 ? '#e03131' : lineColor;
          ctx.fill();
        });
      }

      // 7日表示では点の上に平均値を表示（ガスは除く）
      if (daily && selectedRangeDays <= 7 && !isGas) {
        ctx.font = FONT_S;
        ctx.fillStyle = '#222';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        pos.forEach((p, i) => {
          if (p.y === null) return;
          ctx.fillText(points[i].v.toFixed(1), p.x, Math.max(pad.t + 12, p.y - 8));
        });
      }
    }

    document.querySelectorAll('.tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        selectedField = b.dataset.field;
        drawChart();
      });
    });

    if ($('refreshBtn')) $('refreshBtn').addEventListener('click', refresh);
    window.addEventListener('resize', drawChart);

    // Push通知を受信するService Workerを登録する。既存登録は解除しない。
    registerPushWorker()
      .then(() => syncServiceWorkerPreferences())
      .catch(error => console.warn('Service Worker登録エラー:', error));

    setupTemperatureSettings();
    setupDashboardFeatures();

    refresh();
    refreshLatestAudio();

    const refreshInterval = Math.max(30000, Number(cfg.refreshMs) || 30000);
    setInterval(refresh, refreshInterval);

    // 他の端末で変えた温度・運転モードを取り込む
    setInterval(() => { if (!document.hidden) syncDeviceSettings(); }, 15000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncDeviceSettings();
    });

    // 音声も定期的に最新URLへ更新する。再生中は中断しない。
    const audioRefreshInterval = Math.max(30000, Number(cfg.audioRefreshMs) || 60000);
    setInterval(() => {
      const player = $('latestAudio');
      if (!player || player.paused || player.ended) {
        refreshLatestAudio();
      }
    }, audioRefreshInterval);
  }

  (async () => {
    const session = await getValidSession();
    if (session && await validateSession(session)) {
      showApp();
    } else {
      saveSession(null);
      showLogin();
    }
  })();

  // アプリを開いたまま長時間経過した場合や、別アプリから戻った場合に認証を再確認。
  let sessionValidationInProgress = false;
  async function revalidateOnReturn() {
    if (document.visibilityState !== 'visible' || sessionValidationInProgress) return;
    sessionValidationInProgress = true;
    try {
      const session = await getValidSession();
      if (!session || !(await validateSession(session))) {
        saveSession(null);
        showLogin();
      }
    } finally {
      sessionValidationInProgress = false;
    }
  }
  document.addEventListener('visibilitychange', revalidateOnReturn);
  window.addEventListener('focus', revalidateOnReturn);
})();
