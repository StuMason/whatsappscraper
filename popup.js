document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('startScraping');
  const stopButton = document.getElementById('stopScraping');
  const statusDiv = document.getElementById('status');
  const batchSizeInput = document.getElementById('batchSize');

  let isRunning = false;

  async function updateButtons(running) {
    isRunning = running;
    startButton.disabled = running;
    stopButton.disabled = !running;
    batchSizeInput.disabled = running;
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
      
      // First check if we can establish connection
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

      // Listen for download requests from content script
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'downloadBatch') {
          const blob = new Blob([JSON.stringify(request.messages, null, 2)], { 
            type: 'application/json' 
          });
          
          chrome.downloads.download({
            url: URL.createObjectURL(blob),
            filename: `${request.chatName}_batch_${request.batchNumber}.json`,
            saveAs: false
          }, () => {
            sendResponse({ status: 'downloaded' });
          });
          
          statusDiv.textContent = `Downloaded batch ${request.batchNumber}...`;
          return true;
        }
      });

      // Start scraping
      chrome.tabs.sendMessage(tab.id, { 
        action: 'startScraping',
        batchSize: parseInt(batchSizeInput.value) || 10
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
        // We'll let the final completion message from the scrape update the buttons
      }
    });
  });

  // Initialize button states
  updateButtons(false);
});