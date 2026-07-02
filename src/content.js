(function runElarionBlocker() {
  const {
    DEFAULT_SETTINGS,
    SITE_RULES,
    GENERIC_AI_TEXT_PATTERNS,
    GENERIC_AD_SELECTORS,
    AI_HEURISTIC_PHRASES
  } = globalThis.ELARION_DEFAULTS;

  const state = {
    settings: DEFAULT_SETTINGS,
    blocked: 0,
    labeled: 0,
    observer: null,
    scanned: new WeakSet(),
    queued: false
  };

  const chromeApi = typeof chrome !== "undefined" ? chrome : null;

  function isExtensionContextReady() {
    return Boolean(chromeApi && chromeApi.storage && chromeApi.runtime?.id);
  }

  async function loadSettings() {
    if (!isExtensionContextReady()) return DEFAULT_SETTINGS;
    const stored = await chromeApi.storage.sync.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  function sendRuntimeMessage(message) {
    try {
      const result = chromeApi.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The extension context can disappear while a tab is still alive.
    }
  }

  function normalizeHost(hostname) {
    return hostname.replace(/^www\./, "").toLowerCase();
  }

  function isSiteDisabled(settings) {
    const host = normalizeHost(location.hostname);
    return settings.disabledSites.some((site) => host === site || host.endsWith(`.${site}`));
  }

  function isAllowed(settings, elementText) {
    const host = normalizeHost(location.hostname);
    const domainAllowed = settings.allowlist.some((site) => host === site || host.endsWith(`.${site}`));
    if (domainAllowed) return true;
    return settings.allowlist.some((entry) => entry && elementText.toLowerCase().includes(entry.toLowerCase()));
  }

  function safeMatches(element, selector) {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  }

  function safeQuerySelectorAll(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function textMatches(text, patterns) {
    const lower = text.toLowerCase();
    return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  }

  function regexMatches(text, rules) {
    return rules.some((rule) => {
      try {
        return new RegExp(rule.pattern, rule.flags || "i").test(text);
      } catch {
        return false;
      }
    });
  }

  function getSiteRules() {
    const host = normalizeHost(location.hostname);
    return SITE_RULES.filter((rule) => rule.hostIncludes.some((part) => host.includes(part)));
  }

  function getElementSearchText(element) {
    const parts = [
      element.innerText || "",
      element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("alt") || ""
    ];

    element.querySelectorAll("[aria-label], [title], img[alt], a[href]").forEach((node) => {
      parts.push(node.getAttribute("aria-label") || "");
      parts.push(node.getAttribute("title") || "");
      parts.push(node.getAttribute("alt") || "");
      parts.push(node.getAttribute("href") || "");
    });

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function sourceDomainMatches(element, domains) {
    if (!domains?.length) return false;
    const links = Array.from(element.querySelectorAll("a[href]"));
    return links.some((link) => {
      try {
        const host = normalizeHost(new URL(link.href, location.href).hostname);
        return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
      } catch {
        return false;
      }
    });
  }

  function getBlockTarget(element) {
    if (normalizeHost(location.hostname).includes("pinterest.")) {
      return element.closest("[data-test-id='pin'], [data-test-id='pinWrapper'], [data-test-id='closeup-main-pin'], [role='listitem'], [data-grid-item]")
        || element;
    }
    return element;
  }

  function getCandidateBlocks(root) {
    const selectors = [
      "article",
      "aside",
      "section",
      "[role='article']",
      "[role='complementary']",
      "[role='region']",
      "[data-testid*='post' i]",
      "[data-testid*='result' i]",
      "[data-test-id='pin']",
      "[data-test-id='pinWrapper']",
      "[data-test-id='closeup-main-pin']",
      "[data-test-id*='pin' i]",
      "[role='listitem']",
      ".post",
      ".result",
      ".card"
    ];
    const candidates = new Set();
    selectors.forEach((selector) => safeQuerySelectorAll(root, selector).forEach((node) => candidates.add(node)));
    return Array.from(candidates).filter((element) => element instanceof HTMLElement);
  }

  function scoreAiLikeText(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 220) return 0;

    let score = 0;
    const lower = clean.toLowerCase();
    const sentences = clean.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
    const words = clean.split(/\s+/).filter(Boolean);
    const avgSentenceLength = words.length / Math.max(sentences.length, 1);
    const phraseHits = AI_HEURISTIC_PHRASES.filter((phrase) => lower.includes(phrase)).length;

    score += phraseHits * 2;
    if (sentences.length >= 5 && avgSentenceLength >= 16 && avgSentenceLength <= 28) score += 2;
    if ((clean.match(/:/g) || []).length >= 4) score += 1;
    if ((clean.match(/\b(first|second|third|finally|additionally|furthermore|moreover)\b/gi) || []).length >= 4) score += 2;
    if ((clean.match(/\b(may|might|can help|designed to|generally|typically)\b/gi) || []).length >= 5) score += 2;
    if ((clean.match(/\b(specific|concrete|named|measured|according to)\b/gi) || []).length === 0 && words.length > 350) score += 1;

    return score;
  }

  function findReason(element, settings) {
    const text = getElementSearchText(element);
    if (!text.trim() && element.tagName !== "IFRAME") return null;
    if (isAllowed(settings, text)) return null;

    const host = normalizeHost(location.hostname);
    if (settings.customDomainRules.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return "custom domain rule";
    }
    if (sourceDomainMatches(element, settings.customDomainRules)) {
      return "custom source domain rule";
    }

    if (settings.blockAds && GENERIC_AD_SELECTORS.some((selector) => safeMatches(element, selector))) {
      return "ad selector";
    }

    if (settings.blockAiFeatures) {
      const siteRule = getSiteRules().find((rule) => {
        const selectorHit = rule.selectors.some((selector) => safeMatches(element, selector));
        const textHit = textMatches(text, rule.textPatterns);
        const sourceHit = sourceDomainMatches(element, rule.sourceDomains);
        if (rule.selectorRequiresEvidence) return sourceHit || (selectorHit && textHit);
        return selectorHit || textHit || sourceHit;
      });
      if (siteRule) return siteRule.id;

      if (textMatches(text, GENERIC_AI_TEXT_PATTERNS)) return "AI feature text";
      if (regexMatches(text, settings.customTextRules)) return "custom text rule";
      if (settings.customSelectorRules.some((selector) => safeMatches(element, selector))) return "custom selector rule";
    }

    if (settings.heuristicDetection && scoreAiLikeText(text) >= settings.heuristicThreshold) {
      return "AI-like writing pattern";
    }

    return null;
  }

  function applyAction(element, reason, settings) {
    const target = getBlockTarget(element);
    if (target.dataset.elarionBlocked === "true") return;
    target.dataset.elarionBlocked = "true";
    target.dataset.elarionReason = reason;

    if (settings.mode === "label") {
      target.classList.add("elarion-labeled");
      if (!target.querySelector(":scope > .elarion-label-badge")) {
        const badge = document.createElement("div");
        badge.className = "elarion-label-badge";
        badge.textContent = `Elarion flagged: ${reason}`;
        target.prepend(badge);
      }
      state.labeled += 1;
    } else if (settings.mode === "blur") {
      target.classList.add("elarion-blurred");
      state.blocked += 1;
    } else {
      target.classList.add("elarion-hidden");
      state.blocked += 1;
    }
  }

  function scanSelectors(root, settings) {
    const selectorGroups = [];
    if (settings.blockAds) selectorGroups.push(...GENERIC_AD_SELECTORS);
    if (settings.blockAiFeatures) {
      getSiteRules()
        .filter((rule) => !rule.selectorRequiresEvidence)
        .forEach((rule) => selectorGroups.push(...rule.selectors));
      selectorGroups.push(...settings.customSelectorRules);
    }

    selectorGroups.forEach((selector) => {
      safeQuerySelectorAll(root, selector).forEach((element) => {
        if (element instanceof HTMLElement) {
          applyAction(element, selector, settings);
        }
      });
    });
  }

  function scanPage() {
    if (!state.settings.enabled || isSiteDisabled(state.settings)) return;

    scanSelectors(document, state.settings);
    for (const element of getCandidateBlocks(document)) {
      if (state.scanned.has(element)) continue;
      state.scanned.add(element);
      const reason = findReason(element, state.settings);
      if (reason) applyAction(element, reason, state.settings);
    }

    if (isExtensionContextReady()) {
      sendRuntimeMessage({
        type: "ELARION_STATS",
        url: location.href,
        host: location.hostname,
        blocked: state.blocked,
        labeled: state.labeled
      });
    }
  }

  function queueScan() {
    if (state.queued) return;
    state.queued = true;
    window.setTimeout(() => {
      state.queued = false;
      scanPage();
    }, 300);
  }

  async function init() {
    state.settings = await loadSettings();
    scanPage();
    state.observer = new MutationObserver(queueScan);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });

    if (isExtensionContextReady()) {
      chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "ELARION_GET_PAGE_STATS") {
          sendResponse({ blocked: state.blocked, labeled: state.labeled, host: location.hostname });
        }
        if (message?.type === "ELARION_REFRESH") {
          state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
          scanPage();
          sendResponse({ ok: true });
        }
        return true;
      });
    }
  }

  init();
})();
