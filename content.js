// ── Login form fill ──────────────────────────────────────────────────────────

async function performLogin() {
  try {
    const data = await chrome.storage.local.get(['username', 'password', 'autoSubmit']);

    if (!data.username || !data.password) {
      return { success: false, message: 'no credentials saved' };
    }

    const usernameField = document.querySelector('input[name="username"], input[type="text"], input#username');
    const passwordField = document.querySelector('input[name="password"], input[type="password"], input#password');
    const submitButton  = document.querySelector('input[type="submit"], button[type="submit"], button');

    if (usernameField && passwordField) {
      usernameField.value = data.username;
      passwordField.value = data.password;

      usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));

      if (data.autoSubmit && submitButton) {
        setTimeout(() => { submitButton.click(); }, 500);
        return { success: true, message: 'logging in...' };
      } else {
        return { success: true, message: 'filled in, click login' };
      }
    } else {
      return { success: false, message: 'no form found' };
    }
  } catch (error) {
    return { success: false, message: 'error: ' + error.message };
  }
}

// ── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'login') {
    performLogin().then(result => { sendResponse(result); });
    return true;
  }

  if (request.action === 'setFloatingBtn') {
    if (request.visible) {
      injectFloatingButton();
    } else {
      removeFloatingButton();
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Floating button ──────────────────────────────────────────────────────────

const BTN_ID = 'alcasar-float-btn';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif";

const BASE_STYLE = `
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483647;
  font-family: ${FONT};
  width: 120px;
  height: 48px;
  border: none;
  cursor: pointer;
  outline: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
  transition: background 0.2s, opacity 0.2s;
  padding: 0;
`;

function removeFloatingButton() {
  const el = document.getElementById(BTN_ID);
  if (el) el.remove();
}

function setButtonState(btn, state, userName) {
  btn.innerHTML = '';

  if (state === 'idle') {
    btn.disabled = false;
    btn.style.background = '#0066FF';
    btn.style.cursor = 'pointer';
    btn.style.opacity = '1';

    const label = document.createElement('span');
    label.textContent = 'LOGIN';
    label.style.fontFamily = FONT;
    label.style.color = '#ffffff';
    label.style.fontSize = '12px';
    label.style.fontWeight = '700';
    label.style.textTransform = 'uppercase';
    label.style.letterSpacing = '1.5px';
    btn.appendChild(label);

  } else if (state === 'loading') {
    btn.disabled = true;
    btn.style.background = '#0066FF';
    btn.style.cursor = 'not-allowed';
    btn.style.opacity = '0.55';

    const label = document.createElement('span');
    label.textContent = 'LOGGING IN';
    label.style.fontFamily = FONT;
    label.style.color = '#ffffff';
    label.style.fontSize = '11px';
    label.style.fontWeight = '700';
    label.style.textTransform = 'uppercase';
    label.style.letterSpacing = '1px';
    btn.appendChild(label);

  } else if (state === 'connected') {
    btn.disabled = true;
    btn.style.background = '#f4f4f4';
    btn.style.cursor = 'default';
    btn.style.opacity = '1';

    if (userName) {
      const name = document.createElement('span');
      name.textContent = userName.split('@')[0].toUpperCase();
      name.style.fontFamily = FONT;
      name.style.color = '#0066FF';
      name.style.fontSize = '9px';
      name.style.fontWeight = '600';
      name.style.letterSpacing = '0.8px';
      name.style.opacity = '0.7';
      btn.appendChild(name);
    }

    const label = document.createElement('span');
    label.textContent = 'CONNECTED';
    label.style.fontFamily = FONT;
    label.style.color = '#0066FF';
    label.style.fontSize = '11px';
    label.style.fontWeight = '700';
    label.style.textTransform = 'uppercase';
    label.style.letterSpacing = '1.2px';
    btn.appendChild(label);
  }
}

// N2: semaphore prevents two concurrent injectFloatingButton() calls (e.g. SPA
// navigation firing the content script twice) from both passing the DOM guard,
// both awaiting, and both appending a button.
let _injecting = false;

async function injectFloatingButton() {
  // N2: bail if a button already exists OR an injection is already in flight
  if (document.getElementById(BTN_ID) || _injecting) return;
  _injecting = true;

  try {
    let clientState = -1;
    let userName    = null;
    let loginInProgress = false;

    try {
      const [statusRes, storageRes] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'checkStatus' }),
        chrome.storage.local.get(['loginInProgress'])
      ]);
      clientState     = statusRes.clientState;
      userName        = statusRes.userName;
      loginInProgress = !!storageRes.loginInProgress;
    } catch (_) { /* no-op */ }

    // Check again after the async gap — another call may have won the race
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.style.cssText = BASE_STYLE;

    // B4: attach hover and click listeners unconditionally so they are always
    // present, even when the button starts in loading state and later times out
    // back to idle. btn.disabled guards already prevent action in wrong states.
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) btn.style.background = '#0052CC';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) btn.style.background = '#0066FF';
    });
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      setButtonState(btn, 'loading', null);
      chrome.runtime.sendMessage({ action: 'startLogin' }, (response) => {
        if (response && response.alreadyLoggedIn) {
          setButtonState(btn, 'connected', response.userName);
        } else {
          pollFloatingUntilConnected(btn);
        }
      });
    });

    // Set initial visual state only — listeners are already attached above
    if (clientState === 1) {
      setButtonState(btn, 'connected', userName);
    } else if (loginInProgress) {
      setButtonState(btn, 'loading', null);
      pollFloatingUntilConnected(btn);
    } else {
      setButtonState(btn, 'idle', null);
    }

    document.body.appendChild(btn);
  } finally {
    _injecting = false;
  }
}

async function pollFloatingUntilConnected(btn) {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (!document.getElementById(BTN_ID)) return; // button removed, stop
    try {
      const status = await chrome.runtime.sendMessage({ action: 'checkStatus' });
      if (status && status.clientState === 1) {
        setButtonState(btn, 'connected', status.userName);
        return;
      }
    } catch (_) { return; }
  }
  // Timed out — restore idle so the button can be clicked again (B4 fix means
  // listeners are already attached, so this just re-enables the button)
  setButtonState(btn, 'idle', null);
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const data = await chrome.storage.local.get(['floatingBtnEnabled']);
    const enabled = data.floatingBtnEnabled !== false;
    if (enabled) injectFloatingButton();
  } catch (_) { /* no-op */ }
})();
