// Flag to track if we're already initialized
let isInitialized = false;
let shouldStop = false;
let batchSize = 10; // Default batch size

// Initialize message listeners
function initialize() {
  if (isInitialized) return;
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Content script received message:', request);
    
    if (request.action === 'ping') {
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