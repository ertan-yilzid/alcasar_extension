const STATUS_URL = 'https://alcasar.laplateforme.io:3991/json/status';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startLogin') {
    handleLogin(sendResponse);
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

async function handleLogin(sendResponse) {
  try {
    const creds = await chrome.storage.local.get(['username', 'password']);
    if (!creds.username || !creds.password) {
      if (sendResponse) {
        sendResponse({ success: false, noCredentials: true, message: 'no credentials saved' });
      }
      return;
    }

    const status = await fetchLoginStatus();
    if (status.clientState === 1) {
      if (sendResponse) {
        sendResponse({
          success: false,
          alreadyLoggedIn: true,
          message: 'already logged in',
          userName: status.userName
        });
      }
      return;
    }

    await chrome.storage.local.set({ loginInProgress: true });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTab;

    if (currentTab && currentTab.url && currentTab.url.includes('alcasar.laplateforme.io/intercept.php')) {
      targetTab = currentTab;
    } else if (currentTab && currentTab.url && currentTab.url.includes('alcasar.laplateforme.io')) {
      targetTab = currentTab;
      await chrome.tabs.update(targetTab.id, { url: 'https://alcasar.laplateforme.io/intercept.php' });
      await waitForTabLoad(targetTab.id);
    } else {
      targetTab = await chrome.tabs.create({
        url: 'https://alcasar.laplateforme.io/intercept.php',
        active: true
      });
      await waitForTabLoad(targetTab.id);
    }

    await sleep(1500);

    // Reply to popup immediately — it polls for the result
    if (sendResponse) {
      sendResponse({ success: true, message: 'starting login' });
      sendResponse = null;
    }

    // Register redirect watcher BEFORE submitting the form
    const redirectPromise = watchForLoginRedirect(targetTab.id);

    try {
      await chrome.tabs.sendMessage(targetTab.id, { action: 'login' });
    } catch (error) {
      console.error('login message error:', error);
    }

    await redirectPromise;

  } catch (error) {
    console.error('handleLogin error:', error);
    if (sendResponse) {
      sendResponse({ success: false, message: 'error: ' + error.message });
    }
  } finally {
    // Remove loginInProgress AFTER redirectPromise has fully resolved,
    // so loginError is already in storage before the flag disappears.
    await chrome.storage.local.remove('loginInProgress');
  }
}

function watchForLoginRedirect(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;

    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.webNavigation.onBeforeNavigate.removeListener(navListener);
      chrome.webNavigation.onCommitted.removeListener(navListener);
      chrome.webNavigation.onCompleted.removeListener(navListener);
      chrome.tabs.onUpdated.removeListener(tabListener);
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    function handleUrl(url) {
      if (done || !url) return;

      if (url.includes('res=success')) {
        cleanup();
        pollLoginStatus(tabId).then(resolve);

      } else if (url.includes('res=failed')) {
        cleanup();

        let reason = 'wrong credentials';
        try {
          const params = new URL(url).searchParams;
          const r = params.get('reason');
          if (r) reason = r === 'reject' ? 'wrong credentials' : r;
        } catch (_) { /* keep default */ }

        // Set loginError in storage (for floating button + popup reopen fallback),
        // then push a direct message to the popup if it's still open.
        chrome.storage.local.set({ loginError: reason }).then(() => {
          chrome.runtime.sendMessage({ action: 'loginResult', error: reason }).catch(() => {
            // Popup was already closed — storage fallback will handle it on reopen.
          });
          resolve();
        });
      }
    }

    function navListener(details) {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      handleUrl(details.url);
    }
    chrome.webNavigation.onBeforeNavigate.addListener(navListener);
    chrome.webNavigation.onCommitted.addListener(navListener);
    chrome.webNavigation.onCompleted.addListener(navListener);

    function tabListener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        handleUrl(tab.url);
      });
    }
    chrome.tabs.onUpdated.addListener(tabListener);
  });
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

async function pollLoginStatus(tabId) {
  const maxPolls = 30;

  for (let i = 0; i < maxPolls; i++) {
    try {
      const status = await fetchLoginStatus();
      if (status.clientState === 1) {
        await chrome.tabs.update(tabId, { url: 'https://intra.laplateforme.io' });
        return;
      }
    } catch (error) {
      console.error('status check error:', error);
    }

    await sleep(1000);
  }
}
