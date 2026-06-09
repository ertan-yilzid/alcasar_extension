let _popupAlive = true;
window.addEventListener('unload', () => { _popupAlive = false; });

document.addEventListener('DOMContentLoaded', async () => {

  // ── Listen for login result pushed directly from background ───────────────
  // Registered FIRST — before any async work — so no message can slip through
  // during an awaited gap. Background pushes this as soon as it sees res=failed
  // or res=success in the redirect URL.
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action !== 'loginResult') return;
    if (request.error) {
      setButtonState('idle', null);
      showLoginStatus(request.error, 'error');
    }
    // success is handled by checkAndApplyLoginState on reopen
  });

  // ── Load saved credentials + toggle state ─────────────────────────────────
  try {
    const data = await chrome.storage.local.get(['username', 'password', 'floatingBtnEnabled']);
    if (data.username) document.getElementById('username').value = data.username;
    if (data.password) document.getElementById('password').value = data.password;
    document.getElementById('floatingToggle').checked = data.floatingBtnEnabled !== false;
  } catch (error) {
    console.error('error loading:', error);
  }

  // ── Check login status on popup open ──────────────────────────────────────
  await checkAndApplyLoginState();

  // ── Settings gear ─────────────────────────────────────────────────────────
  document.getElementById('settingsBtn').addEventListener('click', () => {
    const panel = document.getElementById('settingsPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // ── Floating button toggle ─────────────────────────────────────────────────
  document.getElementById('floatingToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      await chrome.storage.local.set({ floatingBtnEnabled: enabled });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('alcasar.laplateforme.io')) {
        chrome.tabs.sendMessage(tab.id, { action: 'setFloatingBtn', visible: enabled });
      }
    } catch (error) {
      console.error('toggle error:', error);
    }
  });

  // ── Login button ───────────────────────────────────────────────────────────
  document.getElementById('loginNow').addEventListener('click', async () => {
    const button = document.getElementById('loginNow');
    if (button.disabled) return;

    setButtonState('loading', null);

    try {
      chrome.runtime.sendMessage({ action: 'startLogin' }, (response) => {
        if (response && response.alreadyLoggedIn) {
          setButtonState('connected', response.userName);
        } else if (response && response.noCredentials) {
          setButtonState('idle', null);
          showLoginStatus('no credentials saved', 'error');
          document.getElementById('settingsPanel').style.display = 'block';
        } else if (response && !response.success) {
          setButtonState('idle', null);
          showLoginStatus(response.message, 'error');
        } else {
          // Login attempt started — poll storage every second.
          // The background also pushes a loginResult message directly,
          // but polling storage is the reliable fallback when the popup
          // survives the tab navigation (e.g. already on intercept.php).
          pollUntilDone();
        }
      });
    } catch (error) {
      console.error('error:', error);
      showLoginStatus('error: ' + error.message, 'error');
      setButtonState('idle', null);
    }
  });

  // ── Save credentials ───────────────────────────────────────────────────────
  document.getElementById('saveCredentials').addEventListener('click', async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showStatus('fill in both fields', 'error');
      return;
    }

    try {
      await chrome.storage.local.set({ username, password, autoSubmit: true });
      showStatus('saved!', 'success');
    } catch (error) {
      console.error('error saving:', error);
      showStatus('failed to save', 'error');
    }
  });
});

// ── Button state helpers ──────────────────────────────────────────────────────

function setButtonState(state, userName) {
  const button = document.getElementById('loginNow');
  const subEl  = document.getElementById('btnSub');
  const mainEl = document.getElementById('btnMain');

  if (state === 'idle') {
    button.disabled = false;
    subEl.textContent = '';
    subEl.classList.remove('visible');
    mainEl.textContent = 'Login';
    mainEl.style.fontSize = '13px';
    mainEl.style.letterSpacing = '1.2px';
    mainEl.style.opacity = '1';

  } else if (state === 'loading') {
    button.disabled = true;
    subEl.textContent = '';
    subEl.classList.remove('visible');
    mainEl.textContent = 'Logging in...';
    mainEl.style.fontSize = '11px';
    mainEl.style.letterSpacing = '1px';
    mainEl.style.opacity = '0.45';

  } else if (state === 'connected') {
    button.disabled = true;
    const displayName = userName ? userName.split('@')[0].toUpperCase() : null;
    if (displayName) {
      subEl.textContent = displayName;
      subEl.classList.add('visible');
    } else {
      subEl.classList.remove('visible');
    }
    mainEl.textContent = 'Connected';
    mainEl.style.fontSize = '11px';
    mainEl.style.letterSpacing = '1.2px';
    mainEl.style.opacity = '1';
  }
}

// ── Status check on popup open ────────────────────────────────────────────────

async function checkAndApplyLoginState() {
  try {
    const [status, storageData] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'checkStatus' }),
      chrome.storage.local.get(['loginInProgress', 'loginError'])
    ]);

    if (status && status.clientState === 1) {
      await chrome.storage.local.remove(['loginInProgress', 'loginError']);
      setButtonState('connected', status.userName);

    } else if (storageData.loginError) {
      // Popup was closed during login and reopened after failure
      const msg = storageData.loginError;
      await chrome.storage.local.remove('loginError');
      setButtonState('idle', null);
      showLoginStatus(msg, 'error');

    } else if (storageData.loginInProgress) {
      // Login still in flight — show loading and poll
      setButtonState('loading', null);
      pollUntilDone();

    } else {
      setButtonState('idle', null);
    }
  } catch (error) {
    console.error('status check error:', error);
  }
}

// Polls storage every second for loginError or connected state.
// Runs alongside the loginResult message listener — whichever fires first wins.
let _polling = false;
async function pollUntilDone() {
  if (_polling) return;
  _polling = true;

  try {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      if (!_popupAlive) return;

      try {
        const [status, stored] = await Promise.all([
          chrome.runtime.sendMessage({ action: 'checkStatus' }),
          chrome.storage.local.get('loginError')
        ]);

        if (stored.loginError) {
          const msg = stored.loginError;
          await chrome.storage.local.remove('loginError');
          setButtonState('idle', null);
          showLoginStatus(msg, 'error');
          return;
        }

        if (status && status.clientState === 1) {
          setButtonState('connected', status.userName);
          return;
        }
      } catch (_) {
        return;
      }
    }

    if (_popupAlive) {
      const btn = document.getElementById('loginNow');
      if (btn && btn.disabled) setButtonState('idle', null);
    }
  } finally {
    _polling = false;
  }
}

// ── Status toasts ─────────────────────────────────────────────────────────────

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent   = message;
  el.style.display = '';
  el.className     = `status ${type}`;
  setTimeout(() => { el.className = 'status'; }, 3000);
}

function showLoginStatus(message, type) {
  const el = document.getElementById('loginStatus');
  el.textContent   = message;
  el.style.display = '';
  el.className     = `status ${type}`;
  setTimeout(() => { el.className = 'status'; }, 3000);
}
