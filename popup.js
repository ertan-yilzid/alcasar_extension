// N3: track whether the popup is still open so stale poll loops exit cleanly
let _popupAlive = true;
window.addEventListener('unload', () => { _popupAlive = false; });

// B2: track whether a poll is already running to prevent parallel instances
let _polling = false;

document.addEventListener('DOMContentLoaded', async () => {

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

  // ── Settings gear ──────────────────────────────────────────────────────────
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
        } else {
          // B2: only start a poll if one isn't already running
          pollUntilConnected();
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
  const button  = document.getElementById('loginNow');
  const subEl   = document.getElementById('btnSub');
  const mainEl  = document.getElementById('btnMain');

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

// ── Status check ─────────────────────────────────────────────────────────────

async function checkAndApplyLoginState() {
  try {
    // B1 + N1: read both status and the loginInProgress flag together
    const [status, storageData] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'checkStatus' }),
      chrome.storage.local.get(['loginInProgress'])
    ]);

    if (status && status.clientState === 1) {
      // N1: if we're already connected, clear any stale loginInProgress flag
      // (left over from a previous session where the service worker was killed
      // mid-login or the tab load timed out)
      if (storageData.loginInProgress) {
        chrome.storage.local.remove('loginInProgress');
      }
      setButtonState('connected', status.userName);

    } else if (storageData.loginInProgress) {
      // B1: only show loading and poll when the flag is explicitly set —
      // not merely because an ALCASAR tab happens to be open
      setButtonState('loading', null);
      pollUntilConnected(); // B2: first (and only) poll started here

    } else {
      setButtonState('idle', null);
      // No poll needed — user hasn't started a login
    }
  } catch (error) {
    console.error('status check error:', error);
  }
}

async function pollUntilConnected() {
  // B2: if a poll is already running, don't start another one
  if (_polling) return;
  _polling = true;

  try {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 1000));

      // N3: stop if the popup has been closed
      if (!_popupAlive) return;

      try {
        const status = await chrome.runtime.sendMessage({ action: 'checkStatus' });
        if (status && status.clientState === 1) {
          setButtonState('connected', status.userName);
          return;
        }
      } catch (_) {
        // Extension context invalidated — popup is closing
        return;
      }
    }

    // Timed out — reset to idle if the button is still in loading state
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
  el.textContent = message;
  el.className   = `status ${type}`;
  setTimeout(() => { el.className = 'status'; el.style.display = 'none'; }, 3000);
}

function showLoginStatus(message, type) {
  const el = document.getElementById('loginStatus');
  el.textContent = message;
  el.className   = `status ${type}`;
  setTimeout(() => { el.className = 'status'; el.style.display = 'none'; }, 3000);
}
