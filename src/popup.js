const defaults = globalThis.ELARION_DEFAULTS.DEFAULT_SETTINGS;
const form = {
  enabled: document.querySelector("#enabledToggle"),
  mode: document.querySelector("#modeSelect"),
  ads: document.querySelector("#adsToggle"),
  adNetwork: document.querySelector("#adNetworkToggle"),
  ai: document.querySelector("#aiToggle"),
  heuristic: document.querySelector("#heuristicToggle"),
  debug: document.querySelector("#debugToggle"),
  siteAdAction: document.querySelector("#siteAdAction"),
  siteAiAction: document.querySelector("#siteAiAction"),
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
  await loadStats();
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

function findPresetKey(host) {
  return Object.keys(settings.sitePresets || {}).find((site) => {
    const key = normalizeHost(String(site).trim());
    return key && (host === key || host.endsWith(`.${key}`));
  }) || null;
}

async function updateSitePreset(patch) {
  const host = activeTab?.url ? normalizeHost(new URL(activeTab.url).hostname) : "";
  if (!host) return;
  const key = findPresetKey(host) || host;
  const next = { ...((settings.sitePresets || {})[key] || {}), ...patch };
  const sitePresets = { ...(settings.sitePresets || {}) };
  const isDefault = (value) => !value || value === "default";
  if (isDefault(next.adAction) && isDefault(next.aiAction)) {
    delete sitePresets[key];
  } else {
    sitePresets[key] = next;
  }
  await saveSettings({ sitePresets });
}

function render() {
  const url = activeTab?.url ? new URL(activeTab.url) : null;
  const host = url ? normalizeHost(url.hostname) : "";
  const disabled = settings.disabledSites.includes(host);
  const presetKey = host ? findPresetKey(host) : null;
  const preset = presetKey ? settings.sitePresets[presetKey] : null;
  const presetValue = (value) => (["hide", "blur", "label", "off"].includes(value) ? value : "default");

  form.siteAdAction.value = presetValue(preset?.adAction);
  form.siteAiAction.value = presetValue(preset?.aiAction);
  form.siteAdAction.disabled = !host;
  form.siteAiAction.disabled = !host;

  form.siteLabel.textContent = host || "Current site";
  form.enabled.checked = settings.enabled;
  form.mode.value = settings.mode;
  form.ads.checked = settings.blockAds;
  form.adNetwork.checked = settings.blockAdNetwork;
  form.ai.checked = settings.blockAiFeatures;
  form.heuristic.checked = settings.heuristicDetection;
  form.debug.checked = settings.debugOverlay;
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
  form.adNetwork.addEventListener("change", () => saveSettings({ blockAdNetwork: form.adNetwork.checked }));
  form.ai.addEventListener("change", () => saveSettings({ blockAiFeatures: form.ai.checked }));
  form.heuristic.addEventListener("change", () => saveSettings({ heuristicDetection: form.heuristic.checked }));
  form.debug.addEventListener("change", () => saveSettings({ debugOverlay: form.debug.checked }));
  form.siteAdAction.addEventListener("change", () => updateSitePreset({ adAction: form.siteAdAction.value }));
  form.siteAiAction.addEventListener("change", () => updateSitePreset({ aiAction: form.siteAiAction.value }));
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
