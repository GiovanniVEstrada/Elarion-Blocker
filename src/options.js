const defaults = globalThis.ELARION_DEFAULTS.DEFAULT_SETTINGS;

const fields = {
  mode: document.querySelector("#modeSelect"),
  threshold: document.querySelector("#thresholdInput"),
  allowlist: document.querySelector("#allowlistInput"),
  disabledSites: document.querySelector("#disabledSitesInput"),
  selectors: document.querySelector("#selectorsInput"),
  textRules: document.querySelector("#textRulesInput"),
  domainRules: document.querySelector("#domainRulesInput"),
  save: document.querySelector("#saveButton"),
  reset: document.querySelector("#resetButton"),
  status: document.querySelector("#statusText")
};

function linesToArray(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function arrayToLines(value) {
  return value.join("\n");
}

function textRulesToLines(rules) {
  return rules.map((rule) => rule.pattern).join("\n");
}

function linesToTextRules(value) {
  return linesToArray(value).map((pattern) => ({ pattern, flags: "i" }));
}

function render(settings) {
  fields.mode.value = settings.mode;
  fields.threshold.value = settings.heuristicThreshold;
  fields.allowlist.value = arrayToLines(settings.allowlist);
  fields.disabledSites.value = arrayToLines(settings.disabledSites);
  fields.selectors.value = arrayToLines(settings.customSelectorRules);
  fields.textRules.value = textRulesToLines(settings.customTextRules);
  fields.domainRules.value = arrayToLines(settings.customDomainRules);
}

function collect() {
  return {
    mode: fields.mode.value,
    heuristicThreshold: Number(fields.threshold.value),
    allowlist: linesToArray(fields.allowlist.value),
    disabledSites: linesToArray(fields.disabledSites.value),
    customSelectorRules: linesToArray(fields.selectors.value),
    customTextRules: linesToTextRules(fields.textRules.value),
    customDomainRules: linesToArray(fields.domainRules.value)
  };
}

async function save() {
  await chrome.storage.sync.set(collect());
  fields.status.textContent = "Saved";
  window.setTimeout(() => {
    fields.status.textContent = "";
  }, 1600);
}

async function reset() {
  await chrome.storage.sync.set(defaults);
  render(defaults);
  fields.status.textContent = "Reset";
}

async function init() {
  const settings = { ...defaults, ...(await chrome.storage.sync.get(defaults)) };
  render(settings);
  fields.save.addEventListener("click", save);
  fields.reset.addEventListener("click", reset);
}

init();
