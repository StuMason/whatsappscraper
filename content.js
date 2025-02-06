// Flag to track if we're already initialized
let isInitialized = false;
let shouldStop = false;
let batchSize = 10; // Default batch size
// Add these at the top of content.js with other variables
let privacyStyleSheet = null;

// Add this function to handle style injection
// Update the injectPrivacyStyles function in content.js

function injectPrivacyStyles() {
  if (privacyStyleSheet) return;
  
  privacyStyleSheet = document.createElement('style');
  privacyStyleSheet.textContent = `
    /* Text messages */
    .blur-messages .copyable-text {
      filter: blur(5px) !important;
      transition: filter 0.3s ease !important;
    }
    
    .blur-messages .copyable-text:hover {
      filter: blur(0) !important;
    }
    
    /* Images and media */
    .blur-messages img,
    .blur-messages video,
    .blur-messages ._1VwCy, /* WhatsApp image container */
    .blur-messages ._2HE1Z, /* Media thumbnails */
    .blur-messages .p357zi0d, /* Document thumbnails */
    .blur-messages ._1xXj6, /* Link previews */
    .blur-messages [data-testid="image-thumb"] {
      filter: blur(12px) !important;
      transition: filter 0.3s ease !important;
    }
    
    .blur-messages img:hover,
    .blur-messages video:hover,
    .blur-messages ._1VwCy:hover,
    .blur-messages ._2HE1Z:hover,
    .blur-messages .p357zi0d:hover,
    .blur-messages ._1xXj6:hover,
    .blur-messages [data-testid="image-thumb"]:hover {
      filter: blur(0) !important;
    }
    
    /* Hide mode */
    .hide-messages .copyable-text,
    .hide-messages img,
    .hide-messages video,
    .hide-messages ._1VwCy,
    .hide-messages ._2HE1Z,
    .hide-messages .p357zi0d,
    .hide-messages ._1xXj6,
    .hide-messages [data-testid="image-thumb"] {
      display: none !important;
    }
  `;
  document.head.appendChild(privacyStyleSheet);
}

function togglePrivacyMode(enabled, action = 'blur') {
  // Ensure styles are injected
  injectPrivacyStyles();
  
  // Find the main chat container - using multiple possible selectors
  const chatContainer = document.querySelector('[data-tab="8"]') || 
                       document.querySelector('#main') ||
                       document.querySelector('.app-wrapper-web');
                       
  if (!chatContainer) {
    console.error('Chat container not found');
    return;
  }
  
  console.log('Toggling privacy mode:', { enabled, action });
  
  // Remove existing privacy classes
  chatContainer.classList.remove('blur-messages', 'hide-messages');
  
  // Add new class based on selected action
  if (enabled) {
    chatContainer.classList.add(`${action}-messages`);
  }
}

// Initialize message listeners
function initialize() {
  if (isInitialized) return;
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Content script received message:', request);
    
    if (request.action === 'ping') {
      sendResponse({ status: 'ok' });
      return;
    }


// Add this to your message listener in initialize()
if (request.action === 'togglePrivacy') {
  togglePrivacyMode(request.enabled, request.privacyAction);
  sendResponse({ status: 'ok' });
  return;
}
    
    if (request.action === 'startScraping') {
      shouldStop = false;
      batchSize = request.batchSize || 10; // Get batch size from request
      console.log('Starting scrape with batch size:', batchSize);
      scrapeMessages(batchSize)
        .then(result => {
          console.log('Scrape complete');
          sendResponse({ status: 'complete' });
        })
        .catch(error => {
          console.error('Scrape failed:', error);
          sendResponse({ status: 'error', error: error.message });
        });
      return true;
    }

    if (request.action === 'stopScraping') {
      console.log('Stopping scrape...');
      shouldStop = true;
      sendResponse({ status: 'stopping' });
    }
  });

  chrome.storage.sync.get({
    privacyMode: false,
    privacyAction: 'blur'
  }, (settings) => {
    if (settings.privacyMode) {
      togglePrivacyMode(true, settings.privacyAction);
    }
  });

  isInitialized = true;
  console.log('WhatsApp scraper content script initialized');
}

function findScrollContainer() {
  const pane = document.querySelector('[data-tab="8"]');
  if (!pane) {
    throw new Error('Chat pane not found - please open a chat');
  }

  let element = pane;
  while (element && element !== document.body) {
    const style = window.getComputedStyle(element);
    if (style.overflowY === 'scroll' || style.overflowY === 'auto') {
      return element;
    }
    element = element.parentElement;
  }

  throw new Error('No scrollable container found');
}

function getChatName() {
  const header = document.querySelector('div#main > header');
  if (!header) return 'whatsapp_chat';
  
  const nameElement = header.children[1].querySelector('div > div > span');
  console.log(nameElement);
  return nameElement ? nameElement.textContent.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'whatsapp_chat';
}

function extractMessageData(msg) {
  const textElement = msg.querySelector('.copyable-text');
  const isOutgoing = msg.closest('.message-out') !== null;
  
  // Extract timestamp and sender from the data-pre-plain-text attribute
  // Format is typically "[HH:mm, DD/MM/YYYY] Sender Name: "
  const rawPreText = textElement?.getAttribute('data-pre-plain-text') || '';
  const timestampMatch = rawPreText.match(/\[(.*?)\]/);
  const senderMatch = rawPreText.match(/\](.*?):/);  // Get everything between ] and :
  
  const timestamp = timestampMatch ? timestampMatch[1] : '';
  const sender = senderMatch ? senderMatch[1].trim() : (isOutgoing ? 'You' : 'Unknown');
  
  // Get just the message text without the timestamp
  let text = textElement?.textContent?.trim() || '';
  // Remove any timestamp that might be at the end of the text (like "12:55")
  text = text.replace(/\d{1,2}:\d{2}$/, '').trim();
  
  return {
    id: msg.getAttribute('data-id'),
    type: isOutgoing ? 'sent' : 'received',
    sender: sender,
    text: text,
    timestamp: timestamp
  };
}

async function saveBatch(messages, batchNumber) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'downloadBatch',
      messages: messages,
      batchNumber: batchNumber,
      chatName: getChatName() // Add chat name to the message
    }, response => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response);
      }
    });
  });
}

async function scrapeMessages(batchSize = 10) {
  let messages = [];
  let processedIds = new Set();
  let batchNumber = 1;

  console.log('Finding scroll container...');
  const scrollContainer = findScrollContainer();
  console.log('Found container:', scrollContainer);

  let noNewMessagesCount = 0;
  const MAX_ATTEMPTS = 3;
  
  while (noNewMessagesCount < MAX_ATTEMPTS && !shouldStop) {
    const beforeScroll = scrollContainer.scrollTop;
    const beforeHeight = scrollContainer.scrollHeight;
    
    scrollContainer.scrollTop -= 1000;
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const messageElements = document.querySelectorAll('[data-id]');
    let foundNewMessages = false;

    for (const msg of messageElements) {
      if (shouldStop) break;
      
      const messageId = msg.getAttribute('data-id');
      if (!processedIds.has(messageId)) {
        processedIds.add(messageId);
        foundNewMessages = true;
        
        messages.push(extractMessageData(msg));

        // If we hit batch size, save and clear
        if (messages.length >= batchSize) {
          console.log(`Batch ${batchNumber} full, saving...`);
          await saveBatch(messages, batchNumber);
          messages = [];  // Clear the array
          batchNumber++;
        }
      }
    }

    console.log('Scroll cycle:', {
      scrollDelta: beforeScroll - scrollContainer.scrollTop,
      heightDelta: scrollContainer.scrollHeight - beforeHeight,
      newMessages: foundNewMessages,
      currentBatchSize: messages.length,
      totalProcessed: processedIds.size
    });

    if (!foundNewMessages && beforeScroll === scrollContainer.scrollTop) {
      noNewMessagesCount++;
      console.log(`No changes detected, attempt ${noNewMessagesCount} of ${MAX_ATTEMPTS}`);
    } else {
      noNewMessagesCount = 0;
    }
  }

  // Save any remaining messages
  if (messages.length > 0) {
    await saveBatch(messages, batchNumber);
  }

  const reason = shouldStop ? 'stopped by user' : 'completed';
  console.log(`Scraping ${reason}, processed`, processedIds.size, 'total messages');
}

// Initialize when loaded
initialize();
console.log('Content script loaded');