async function performLogin() {
  try {
    const data = await chrome.storage.sync.get(['username', 'password', 'autoSubmit']);
    
    if (!data.username || !data.password) {
      return { success: false, message: 'no credentials saved' };
    }

    const usernameField = document.querySelector('input[name="username"], input[type="text"], input#username');
    const passwordField = document.querySelector('input[name="password"], input[type="password"], input#password');
    const submitButton = document.querySelector('input[type="submit"], button[type="submit"], button');

    if (usernameField && passwordField) {
      usernameField.value = data.username;
      passwordField.value = data.password;

      usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      
      if (data.autoSubmit && submitButton) {
        setTimeout(() => {
          submitButton.click();
        }, 500);
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'login') {
    performLogin().then(result => {
      sendResponse(result);
    });
    return true;
  }
});
