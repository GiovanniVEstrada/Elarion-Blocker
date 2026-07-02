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

  function getPageHost() {
    // Local test fixtures can impersonate a site with
    // <meta name="elarion-host-override" content="www.pinterest.com">.
    // Honored only on file: pages so remote sites can never use it.
    if (location.protocol === "file:") {
      const override = document.querySelector("meta[name='elarion-host-override']")?.getAttribute("content");
      if (override) return normalizeHost(override.trim());
    }
    return normalizeHost(location.hostname);
  }

  function isSiteDisabled(settings) {
    const host = getPageHost();
    return settings.disabledSites.some((site) => host === site || host.endsWith(`.${site}`));
  }

  function isAllowed(settings, elementText) {
    const host = getPageHost();
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

  function getSiteRules() {
    const host = getPageHost();
    return SITE_RULES.filter((rule) => rule.hostIncludes.some((part) => host.includes(part)));
  }

  function getSearchParts(element) {
    const parts = [
      { source: "visible text", text: element.innerText || "" },
      { source: "aria-label", text: element.getAttribute("aria-label") || "" },
      { source: "title attribute", text: element.getAttribute("title") || "" },
      { source: "image alt text", text: element.getAttribute("alt") || "" }
    ];

    element.querySelectorAll("[aria-label], [title], img[alt], a[href]").forEach((node) => {
      parts.push({ source: "aria-label", text: node.getAttribute("aria-label") || "" });
      parts.push({ source: "title attribute", text: node.getAttribute("title") || "" });
      parts.push({ source: "image alt text", text: node.getAttribute("alt") || "" });
      parts.push({ source: "link URL", text: node.getAttribute("href") || "" });
    });

    // Last so evidence found in more specific parts reports those sources.
    parts.push({ source: "text content", text: element.textContent || "" });
    return parts;
  }

  function joinSearchParts(parts) {
    return parts.map((part) => part.text).join(" ").replace(/\s+/g, " ").trim();
  }

  function locateEvidence(parts, patterns) {
    if (!patterns?.length) return null;
    for (const part of parts) {
      if (!part.text) continue;
      const lower = part.text.toLowerCase();
      const pattern = patterns.find((candidate) => lower.includes(candidate.toLowerCase()));
      if (pattern) return { evidence: pattern, source: part.source };
    }
    return null;
  }

  function findRegexEvidence(parts, text, rules) {
    for (const rule of rules) {
      try {
        const match = text.match(new RegExp(rule.pattern, rule.flags || "i"));
        if (!match) continue;
        const part = parts.find((candidate) =>
          candidate.text && new RegExp(rule.pattern, rule.flags || "i").test(candidate.text));
        return { evidence: match[0] || rule.pattern, source: part ? part.source : "page text" };
      } catch {
        // Invalid custom regex rules are ignored.
      }
    }
    return null;
  }

  function sourceDomainMatches(element, domains) {
    if (!domains?.length) return null;
    for (const link of element.querySelectorAll("a[href]")) {
      try {
        const host = normalizeHost(new URL(link.href, location.href).hostname);
        const domain = domains.find((candidate) => host === candidate || host.endsWith(`.${candidate}`));
        if (domain) return domain;
      } catch {
        // Unparseable hrefs carry no domain evidence.
      }
    }
    return null;
  }

  function getBlockTarget(element) {
    if (getPageHost().includes("pinterest.")) {
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
    const parts = getSearchParts(element);
    const text = joinSearchParts(parts);
    if (!text.trim() && element.tagName !== "IFRAME") return null;
    if (isAllowed(settings, text)) return null;

    const host = getPageHost();
    const hostRule = settings.customDomainRules.find((domain) => host === domain || host.endsWith(`.${domain}`));
    if (hostRule) {
      return { reason: "custom domain rule", evidence: hostRule, source: "page address" };
    }
    const customSource = sourceDomainMatches(element, settings.customDomainRules);
    if (customSource) {
      return { reason: "custom source domain rule", evidence: customSource, source: "link URL" };
    }

    if (settings.blockAds) {
      const adSelector = GENERIC_AD_SELECTORS.find((selector) => safeMatches(element, selector));
      if (adSelector) return { reason: "ad selector", evidence: adSelector, source: "element attributes" };
    }

    if (settings.blockAiFeatures) {
      for (const rule of getSiteRules()) {
        const selectorHit = rule.selectors.find((selector) => safeMatches(element, selector));
        const textHit = locateEvidence(parts, rule.textPatterns);
        const sourceHit = sourceDomainMatches(element, rule.sourceDomains);
        let match = null;
        if (rule.selectorRequiresEvidence) {
          if (sourceHit) match = { evidence: sourceHit, source: "link URL" };
          else if (selectorHit && textHit) match = textHit;
        } else if (textHit) {
          match = textHit;
        } else if (selectorHit) {
          match = { evidence: selectorHit, source: "element attributes" };
        } else if (sourceHit) {
          match = { evidence: sourceHit, source: "link URL" };
        }
        if (match) return { reason: rule.id, ...match };
      }

      const genericHit = locateEvidence(parts, GENERIC_AI_TEXT_PATTERNS);
      if (genericHit) return { reason: "AI feature text", ...genericHit };

      const customText = findRegexEvidence(parts, text, settings.customTextRules);
      if (customText) return { reason: "custom text rule", ...customText };

      const customSelector = settings.customSelectorRules.find((selector) => safeMatches(element, selector));
      if (customSelector) {
        return { reason: "custom selector rule", evidence: customSelector, source: "element attributes" };
      }
    }

    if (settings.heuristicDetection) {
      const score = scoreAiLikeText(text);
      if (score >= settings.heuristicThreshold) {
        return {
          reason: "AI-like writing pattern",
          evidence: `score ${score} (threshold ${settings.heuristicThreshold})`,
          source: "text analysis"
        };
      }
    }

    return null;
  }

  function applyAction(element, detail, settings) {
    const info = typeof detail === "string" ? { reason: detail } : detail;
    const target = getBlockTarget(element);
    if (target.dataset.elarionBlocked === "true") return;
    target.dataset.elarionBlocked = "true";
    target.dataset.elarionReason = info.reason;
    if (info.evidence) target.dataset.elarionEvidence = info.evidence;
    if (info.source) target.dataset.elarionSource = info.source;

    if (settings.debugOverlay) {
      target.classList.add("elarion-debug");
      if (!target.querySelector(":scope > .elarion-debug-badge")) {
        const badge = document.createElement("div");
        badge.className = "elarion-debug-badge";
        [["Reason", info.reason], ["Evidence", info.evidence], ["Source", info.source]].forEach(([label, value]) => {
          if (!value) return;
          const line = document.createElement("div");
          line.textContent = `${label}: ${value}`;
          badge.appendChild(line);
        });
        target.prepend(badge);
      }
      state.labeled += 1;
      return;
    }

    const reason = info.reason;
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
          applyAction(element, { reason: selector, evidence: selector, source: "element attributes" }, settings);
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
      const detail = findReason(element, state.settings);
      if (detail) applyAction(element, detail, state.settings);
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

  function resetActions() {
    document.querySelectorAll(".elarion-label-badge, .elarion-debug-badge").forEach((badge) => badge.remove());
    document.querySelectorAll("[data-elarion-blocked]").forEach((element) => {
      element.classList.remove("elarion-hidden", "elarion-blurred", "elarion-labeled", "elarion-debug");
      delete element.dataset.elarionBlocked;
      delete element.dataset.elarionReason;
      delete element.dataset.elarionEvidence;
      delete element.dataset.elarionSource;
    });
    state.scanned = new WeakSet();
    state.blocked = 0;
    state.labeled = 0;
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
          resetActions();
          scanPage();
          sendResponse({ ok: true });
        }
        return true;
      });
    }
  }

  init();
})();
