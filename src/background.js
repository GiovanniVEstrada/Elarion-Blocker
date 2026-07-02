const pageStats = new Map();

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "ELARION_STATS" || !sender.tab?.id) return;
  pageStats.set(sender.tab.id, {
    blocked: message.blocked || 0,
    labeled: message.labeled || 0,
    host: message.host || "",
    url: message.url || "",
    updatedAt: Date.now()
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageStats.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ELARION_GET_TAB_STATS") return;
  sendResponse(pageStats.get(message.tabId) || { blocked: 0, labeled: 0, host: "", url: "" });
});
