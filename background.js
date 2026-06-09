const STATUS_URL = 'https://alcasar.laplateforme.io:3991/json/status';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startLogin') {
    handleLogin(sendResponse, sender.tab ? sender.tab.id : null);
    return true;
  }

  if (request.action === 'checkStatus') {
    fetchLoginStatus().then(status => {
      sendResponse(status);
    }).catch(() => {
      sendResponse({ clientState: -1, error: true });
    });
    return true;
  }
});

async function fetchLoginStatus() {
  try {
    const response = await fetch(STATUS_URL);
    const data = await response.json();
    return {
      clientState: data.clientState,
      userName: data.session?.userName || null,
      error: false
    };
  } catch (error) {
    return { clientState: -1, error: true };
  }
}

// callerTabId: tab that sent startLogin (floating button), or null (popup)
async function handleLogin(sendResponse, callerTabId) {
  try {
    const creds = await chrome.storage.local.get(['username', 'password']);
    if (!creds.username || !creds.password) {
      if (sendResponse) sendResponse({ success: false, noCredentials: true, message: 'no credentials saved' });
      return;
    }

    const status = await fetchLoginStatus();
    if (status.clientState === 1) {
      if (sendResponse) sendResponse({ success: false, alreadyLoggedIn: true, message: 'already logged in', userName: status.userName });
      return;
    }

    await chrome.storage.local.set({ loginInProgress: true });

    // Determine which tab to use — caller tab if we have one, otherwise active tab
    let targetTabId = callerTabId;
    if (targetTabId == null) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active) targetTabId = active.id;
    }

    // Navigate that tab to the login page
    await chrome.tabs.update(targetTabId, { url: 'https://alcasar.laplateforme.io/intercept.php' });
    await waitForTabLoad(targetTabId);
    await sleep(800);

    // Reply to caller so popup enters its polling/loading state
    if (sendResponse) {
      sendResponse({ success: true, message: 'starting login' });
      sendResponse = null;
    }

    try {
      await chrome.tabs.sendMessage(targetTabId, { action: 'login' });
    } catch (error) {
      console.error('login message error:', error);
    }

    // Poll status API until authenticated, then redirect the same tab to intra
    await pollUntilLoggedIn(targetTabId);

  } catch (error) {
    console.error('handleLogin error:', error);
    if (sendResponse) sendResponse({ success: false, message: 'error: ' + error.message });
  } finally {
    await chrome.storage.local.remove('loginInProgress');
  }
}

async function pollUntilLoggedIn(tabId, maxPolls = 30) {
  for (let i = 0; i < maxPolls; i++) {
    await sleep(1000);

    try {
      const status = await fetchLoginStatus();

      if (status.clientState === 1) {
        chrome.tabs.update(tabId, { url: 'https://intra.laplateforme.io' }).catch(() => {});
        chrome.runtime.sendMessage({ action: 'loginResult', success: true, userName: status.userName }).catch(() => {});
        return;
      }
    } catch (err) {
      console.error('poll error:', err);
    }
  }

  // Timed out
  const reason = 'login timed out';
  await chrome.storage.local.set({ loginError: reason });
  chrome.runtime.sendMessage({ action: 'loginResult', error: reason }).catch(() => {});
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timeout'));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
