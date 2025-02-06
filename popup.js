async function ensureContentScriptLoaded(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    console.log('Content script response:', response);
    return true;
  } catch (e) {
    console.log('Content script not loaded, injecting...', e);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    // Wait a bit for the script to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    return true;
  }
}

// Helper functions for different export formats
function formatMessagesAsCSV(messages, options) {
  const headers = ['Message'];
  if (options.includeTimestamps) headers.unshift('Timestamp');
  if (options.includeSenderInfo) headers.unshift('Sender');
  
  const rows = messages.map(msg => {
    const row = [msg.text];
    if (options.includeTimestamps) row.unshift(msg.timestamp);
    if (options.includeSenderInfo) row.unshift(msg.sender);
    return row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',');
  });
  
  return [headers.join(','), ...rows].join('\n');
}

function formatMessagesAsText(messages, options) {
  return messages.map(msg => {
    const parts = [msg.text];
    if (options.includeTimestamps) parts.unshift(`[${msg.timestamp}]`);
    if (options.includeSenderInfo) parts.unshift(msg.sender + ':');
    return parts.join(' ');
  }).join('\n');
}

// Global variables for event handlers
let globalDownloadHandler = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Get DOM elements
  const startButton = document.getElementById('startScraping');
  const stopButton = document.getElementById('stopScraping');
  const statusDiv = document.getElementById('status');
  const batchSizeInput = document.getElementById('batchSize');
  const includeTimestamps = document.getElementById('includeTimestamps');
  const includeSenderInfo = document.getElementById('includeSenderInfo');
  const exportFormatInputs = document.querySelectorAll('input[name="exportFormat"]');

  let isRunning = false;

  // Load saved settings
  async function loadSettings() {
    const settings = await chrome.storage.sync.get({
      batchSize: 10,
      includeTimestamps: true,
      includeSenderInfo: true,
      exportFormat: 'json'
    });

    batchSizeInput.value = settings.batchSize;
    includeTimestamps.checked = settings.includeTimestamps;
    includeSenderInfo.checked = settings.includeSenderInfo;
    document.querySelector(`input[value="${settings.exportFormat}"]`).checked = true;
  }

  // Save settings when changed
  async function saveSettings() {
    const settings = {
      batchSize: parseInt(batchSizeInput.value),
      includeTimestamps: includeTimestamps.checked,
      includeSenderInfo: includeSenderInfo.checked,
      exportFormat: document.querySelector('input[name="exportFormat"]:checked').value
    };

    await chrome.storage.sync.set(settings);
  }

  // Add change listeners to all settings
  [batchSizeInput, includeTimestamps, includeSenderInfo]
    .forEach(element => element.addEventListener('change', saveSettings));
  
  exportFormatInputs.forEach(input => 
    input.addEventListener('change', saveSettings)
  );

  async function updateButtons(running) {
    isRunning = running;
    startButton.disabled = running;
    stopButton.disabled = !running;
    batchSizeInput.disabled = running;
    
    // Disable settings during scraping
    includeTimestamps.disabled = running;
    includeSenderInfo.disabled = running;
    exportFormatInputs.forEach(input => input.disabled = running);
  }

  function getExportOptions() {
    return {
      format: document.querySelector('input[name="exportFormat"]:checked').value,
      includeTimestamps: includeTimestamps.checked,
      includeSenderInfo: includeSenderInfo.checked
    };
  }

  // Remove existing download handler if it exists
  function cleanupDownloadHandler() {
    if (globalDownloadHandler) {
      chrome.runtime.onMessage.removeListener(globalDownloadHandler);
      globalDownloadHandler = null;
    }
  }

  // Setup download handler
  function setupDownloadHandler() {
    cleanupDownloadHandler();
    
    globalDownloadHandler = (request, sender, sendResponse) => {
      if (request.action === 'downloadBatch') {
        const exportOptions = getExportOptions();
        const messages = request.messages;
        
        let blob;
        let extension;
        
        switch(exportOptions.format) {
          case 'json':
            blob = new Blob([JSON.stringify(messages, null, 2)], { 
              type: 'application/json' 
            });
            extension = 'json';
            break;
            
          case 'csv':
            const csvContent = formatMessagesAsCSV(messages, exportOptions);
            blob = new Blob([csvContent], { type: 'text/csv' });
            extension = 'csv';
            break;
            
          case 'txt':
            const txtContent = formatMessagesAsText(messages, exportOptions);
            blob = new Blob([txtContent], { type: 'text/plain' });
            extension = 'txt';
            break;
        }
        
        chrome.downloads.download({
          url: URL.createObjectURL(blob),
          filename: `${request.chatName}_batch_${request.batchNumber}.${extension}`,
          saveAs: false
        }, () => {
          sendResponse({ status: 'downloaded' });
        });
        
        statusDiv.textContent = `Downloaded batch ${request.batchNumber}...`;
        return true;
      }
    };

    chrome.runtime.onMessage.addListener(globalDownloadHandler);
  }

  startButton.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('web.whatsapp.com')) {
      statusDiv.textContent = 'Please open WhatsApp Web first';
      return;
    }

    try {
      updateButtons(true);
      statusDiv.textContent = 'Scraping in progress...';
      
      // Setup download handler before starting
      setupDownloadHandler();
      
      // Check content script connection
      try {
        const pingResponse = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
        console.log('Content script is ready:', pingResponse);
      } catch (e) {
        console.log('Content script not ready, injecting...');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Start scraping with current settings
      chrome.tabs.sendMessage(tab.id, { 
        action: 'startScraping',
        batchSize: parseInt(batchSizeInput.value),
        options: getExportOptions()
      }, response => {
        if (chrome.runtime.lastError) {
          console.error('Error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Error: Could not connect to page. Try refreshing WhatsApp Web.';
          updateButtons(false);
          return;
        }
        
        if (response && response.status === 'complete') {
          statusDiv.textContent = 'Scraping complete!';
          updateButtons(false);
        } else if (response && response.status === 'error') {
          statusDiv.textContent = `Error: ${response.error}`;
          updateButtons(false);
        }
      });
    } catch (error) {
      console.error('Error:', error);
      statusDiv.textContent = 'Error: ' + error.message;
      updateButtons(false);
    }
  });

  stopButton.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'stopScraping' }, response => {
      if (response && response.status === 'stopping') {
        statusDiv.textContent = 'Stopping scrape...';
      }
    });
  }); 


  const privacyModeToggle = document.getElementById('privacyMode');
  const privacyOptions = document.querySelector('.privacy-options');

  // Function to update privacy mode
  async function updatePrivacyMode() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.includes('web.whatsapp.com')) {
      console.log('Not on WhatsApp Web');
      return;
    }

    const enabled = privacyModeToggle.checked;
    const action = document.querySelector('input[name="privacyAction"]:checked').value;
    
    console.log('Updating privacy mode:', { enabled, action });
    
    // Ensure content script is loaded
    await ensureContentScriptLoaded(tab);

    // Update UI
    privacyOptions.style.display = enabled ? 'block' : 'none';
    
    // Save settings
    await chrome.storage.sync.set({
      privacyMode: enabled,
      privacyAction: action
    });
    
    // Send message to content script
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'togglePrivacy',
        enabled,
        privacyAction: action
      });
      console.log('Privacy mode update response:', response);
    } catch (error) {
      console.error('Error updating privacy mode:', error);
    }
  }

  // Load saved privacy settings
  const settings = await chrome.storage.sync.get({
    privacyMode: false,
    privacyAction: 'blur'
  });

  privacyModeToggle.checked = settings.privacyMode;
  document.querySelector(`input[name="privacyAction"][value="${settings.privacyAction}"]`).checked = true;
  privacyOptions.style.display = settings.privacyMode ? 'block' : 'none';

  // Apply initial privacy settings
  if (settings.privacyMode) {
    await updatePrivacyMode();
  }

  // Event listeners for privacy controls
  privacyModeToggle.addEventListener('change', updatePrivacyMode);
  
  document.querySelectorAll('input[name="privacyAction"]').forEach(radio => {
    radio.addEventListener('change', updatePrivacyMode);
  });

  // Initialize
  await loadSettings();
  updateButtons(false);
});

