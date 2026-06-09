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

    // Signal to content scripts that a login is in progress
    await chrome.storage.local.set({ loginInProgress: true });

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTab;

    if (currentTab && currentTab.url && currentTab.url.includes('alcasar.laplateforme.io/intercept.php')) {
      targetTab = currentTab;
    } else if (currentTab && currentTab.url && currentTab.url.includes('alcasar.laplateforme.io')) {
      targetTab = currentTab;
      await chrome.tabs.update(targetTab.id, { url: 'https://alcasar.laplateforme.io/intercept.php' });
      await waitForTabLoad(targetTab.id); // B5: now has a 15 s timeout
    } else {
      targetTab = await chrome.tabs.create({
        url: 'https://alcasar.laplateforme.io/intercept.php',
        active: true
      });
      await waitForTabLoad(targetTab.id); // B5: now has a 15 s timeout
    }

    await sleep(1500);

    // B3: reply to the popup immediately — it will poll for the result itself
    if (sendResponse) {
      sendResponse({ success: true, message: 'starting login' });
      sendResponse = null; // prevent double-call in the finally path
    }

    try {
      await chrome.tabs.sendMessage(targetTab.id, { action: 'login' });
    } catch (error) {
      console.error('login error:', error);
    }

    await sleep(2000);
    await pollLoginStatus(targetTab.id);

  } catch (error) {
    console.error('error:', error);
    if (sendResponse) {
      sendResponse({ success: false, message: 'error: ' + error.message });
    }
  } finally {
    await chrome.storage.local.remove('loginInProgress');
  }
}

// B5: reject after timeoutMs so handleLogin's finally block cleans up the flag
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
