const LOCAL_SERVER = 'http://127.0.0.1:18735';

// Track connection status
let serverConnected = false;

// Check server connection periodically
async function checkConnection() {
  try {
    const resp = await fetch(`${LOCAL_SERVER}/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    if (resp.ok) {
      const data = await resp.json();
      serverConnected = true;
      chrome.storage.local.set({ serverConnected: true, serverVersion: data.version || '1.0.0' });
    }
  } catch {
    serverConnected = false;
    chrome.storage.local.set({ serverConnected: false });
  }
}

// Check every 10 seconds
checkConnection();
setInterval(checkConnection, 10000);

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  try {
    const config = await chrome.storage.local.get(['enabled', 'program', 'arguments']);

    if (!config.enabled || !serverConnected) {
      return;
    }

    const message = {
      url: downloadItem.url,
      filename: downloadItem.filename || '',
      program: config.program || 'wget',
      arguments: config.arguments || ''
    };

    const resp = await fetch(`${LOCAL_SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000)
    });

    const result = await resp.json();

    if (result.status === 'success') {
      chrome.downloads.cancel(downloadItem.id);
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: '下载已转发',
        message: `已转发到 ${config.program || 'wget'}: ${downloadItem.url}`
      });
    } else {
      console.error('Server returned error:', result.message);
    }
  } catch (error) {
    console.error('Error forwarding download:', error);
  }
});