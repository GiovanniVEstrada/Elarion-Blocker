const defaults = globalThis.ELARION_DEFAULTS.DEFAULT_SETTINGS;
const form = {
  enabled: document.querySelector("#enabledToggle"),
  mode: document.querySelector("#modeSelect"),
  ads: document.querySelector("#adsToggle"),
  ai: document.querySelector("#aiToggle"),
  heuristic: document.querySelector("#heuristicToggle"),
  siteToggle: document.querySelector("#siteToggle"),
  optionsButton: document.querySelector("#optionsButton"),
  blockedCount: document.querySelector("#blockedCount"),
  labeledCount: document.querySelector("#labeledCount"),
  siteLabel: document.querySelector("#siteLabel")
};

let activeTab;
let settings;

function normalizeHost(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(settings);
  await refreshContentScript();
  render();
}

async function refreshContentScript() {
  if (!activeTab?.id) return;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "ELARION_REFRESH", settings });
  } catch {
    // Chrome internal pages cannot receive content-script messages.
  }
}

async function loadStats() {
  if (!activeTab?.id) return;
  try {
    const pageStats = await chrome.tabs.sendMessage(activeTab.id, { type: "ELARION_GET_PAGE_STATS" });
    form.blockedCount.textContent = pageStats.blocked || 0;
    form.labeledCount.textContent = pageStats.labeled || 0;
  } catch {
    const storedStats = await chrome.runtime.sendMessage({ type: "ELARION_GET_TAB_STATS", tabId: activeTab.id });
    form.blockedCount.textContent = storedStats.blocked || 0;
    form.labeledCount.textContent = storedStats.labeled || 0;
  }
}

function render() {
  const url = activeTab?.url ? new URL(activeTab.url) : null;
  const host = url ? normalizeHost(url.hostname) : "";
  const disabled = settings.disabledSites.includes(host);

  form.siteLabel.textContent = host || "Current site";
  form.enabled.checked = settings.enabled;
  form.mode.value = settings.mode;
  form.ads.checked = settings.blockAds;
  form.ai.checked = settings.blockAiFeatures;
  form.heuristic.checked = settings.heuristicDetection;
  form.siteToggle.textContent = disabled ? "Enable on this site" : "Disable on this site";
}

async function init() {
  activeTab = await getActiveTab();
  settings = { ...defaults, ...(await chrome.storage.sync.get(defaults)) };
  render();
  await loadStats();

  form.enabled.addEventListener("change", () => saveSettings({ enabled: form.enabled.checked }));
  form.mode.addEventListener("change", () => saveSettings({ mode: form.mode.value }));
  form.ads.addEventListener("change", () => saveSettings({ blockAds: form.ads.checked }));
  form.ai.addEventListener("change", () => saveSettings({ blockAiFeatures: form.ai.checked }));
  form.heuristic.addEventListener("change", () => saveSettings({ heuristicDetection: form.heuristic.checked }));
  form.siteToggle.addEventListener("click", async () => {
    const host = normalizeHost(new URL(activeTab.url).hostname);
    const disabledSites = settings.disabledSites.includes(host)
      ? settings.disabledSites.filter((site) => site !== host)
      : [...settings.disabledSites, host];
    await saveSettings({ disabledSites });
  });
  form.optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

init();
