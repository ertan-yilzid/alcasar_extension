chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startLogin') {
    handleLogin();
    sendResponse({ success: true, message: 'starting login' });
    return true;
  }
});

async function handleLogin() {
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTab;
    
    if (currentTab && currentTab.url && currentTab.url.includes('alcasar.laplateforme.io')) {
      targetTab = currentTab;
    } else {
      targetTab = await chrome.tabs.create({ 
        url: 'https://alcasar.laplateforme.io/intercept.php',
        active: true
      });
      await waitForTabLoad(targetTab.id);
    }
    
    await sleep(1500);
    
    try {
      await chrome.tabs.sendMessage(targetTab.id, { action: 'login' });
    } catch (error) {
      console.error('login error:', error);
    }
    
    await sleep(2000);
    await pollLoginStatus(targetTab.id);
    
  } catch (error) {
    console.error('error:', error);
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollLoginStatus(tabId) {
  const statusUrl = 'https://alcasar.laplateforme.io:3991/json/status';
  const maxPolls = 30;
  
  for (let i = 0; i < maxPolls; i++) {
    try {
      const response = await fetch(statusUrl);
      const data = await response.json();
      
      if (data.clientState === 1) {
        await chrome.tabs.update(tabId, { url: 'https://intra.laplateforme.io' });
        return;
      }
    } catch (error) {
      console.error('status check error:', error);
    }
    
    await sleep(1000);
  }
}
