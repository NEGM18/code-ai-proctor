console.log("AI Proctoring background worker started.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HEARTBEAT') {
    // Process heartbeat or cheating detection frames
    console.log("Received heartbeat from tab:", sender.tab.id);
    sendResponse({ status: "ok" });
  }
});
