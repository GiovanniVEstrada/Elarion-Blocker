importScripts("defaults.js");

const { DEFAULT_SETTINGS, AD_NETWORK_DOMAINS } = globalThis.ELARION_DEFAULTS;
const AD_NETWORK_RULE_ID = 1;

function isPlainDomain(value) {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(value);
}

async function syncAdNetworkRules() {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
  const excluded = [...settings.disabledSites, ...settings.allowlist]
    .map((entry) => String(entry).trim().toLowerCase().replace(/^www\./, ""))
    .filter(isPlainDomain);

  const addRules = settings.enabled && settings.blockAdNetwork
    ? [{
        id: AD_NETWORK_RULE_ID,
        priority: 1,
        action: { type: "block" },
        condition: {
          requestDomains: AD_NETWORK_DOMAINS,
          domainType: "thirdParty",
          ...(excluded.length ? { excludedInitiatorDomains: excluded } : {})
        }
      }]
    : [];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [AD_NETWORK_RULE_ID],
      addRules
    });
  } catch (error) {
    console.warn("Elarion: could not update ad network rules", error);
  }
}

chrome.runtime.onInstalled.addListener(syncAdNetworkRules);
chrome.runtime.onStartup.addListener(syncAdNetworkRules);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "sync") syncAdNetworkRules();
});

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
