document.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await chrome.storage.sync.get(['username', 'password']);
    
    if (data.username) {
      document.getElementById('username').value = data.username;
    }
    if (data.password) {
      document.getElementById('password').value = data.password;
    }
  } catch (error) {
    console.error('error loading:', error);
  }

  document.getElementById('settingsBtn').addEventListener('click', () => {
    const form = document.getElementById('credentialsForm');
    
    if (form.style.display === 'none') {
      form.style.display = 'block';
    } else {
      form.style.display = 'none';
    }
  });

  document.getElementById('loginNow').addEventListener('click', async () => {
    const button = document.getElementById('loginNow');
    button.disabled = true;
    button.textContent = 'logging in...';
    
    try {
      chrome.runtime.sendMessage({ action: 'startLogin' }, (response) => {
        if (response && response.success) {
          showLoginStatus(response.message, 'success');
        } else {
          showLoginStatus(response?.message || 'starting login', 'success');
        }
        
        setTimeout(() => {
          button.disabled = false;
          button.textContent = 'Login';
        }, 2000);
      });
    } catch (error) {
      console.error('error:', error);
      showLoginStatus('error: ' + error.message, 'error');
      button.disabled = false;
      button.textContent = 'Login';
    }
  });

  document.getElementById('credentialsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    try {
      await chrome.storage.sync.set({
        username: username,
        password: password,
        autoSubmit: true
      });
      
      showStatus('saved!', 'success');
    } catch (error) {
      console.error('error saving:', error);
      showStatus('failed to save, try again', 'error');
    }
  });
});

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  
  setTimeout(() => {
    statusDiv.className = 'status';
    statusDiv.style.display = 'none';
  }, 3000);
}

function showLoginStatus(message, type) {
  const statusDiv = document.getElementById('loginStatus');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  
  setTimeout(() => {
    statusDiv.className = 'status';
    statusDiv.style.display = 'none';
  }, 3000);
}
