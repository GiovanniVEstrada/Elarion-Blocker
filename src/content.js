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
    queued: false,
    pendingRoots: new Set(),
    needsFullSweep: true
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

  const PRESET_ACTIONS = ["hide", "blur", "label", "off"];

  function getSitePreset(settings) {
    const host = getPageHost();
    for (const [site, preset] of Object.entries(settings.sitePresets || {})) {
      const key = normalizeHost(String(site).trim());
      if (key && (host === key || host.endsWith(`.${key}`))) return preset;
    }
    return null;
  }

  function getEffectiveAction(category, settings) {
    if (settings.debugOverlay) return "debug";
    if (category !== "ad" && category !== "ai") return settings.mode;
    const preset = getSitePreset(settings);
    const action = preset?.[category === "ad" ? "adAction" : "aiAction"];
    return PRESET_ACTIONS.includes(action) ? action : settings.mode;
  }

  function getSearchParts(element) {
    // No innerText here: it forces synchronous layout on every candidate,
    // and textContent already covers the same text.
    const parts = [
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
    parts.push({ source: "page text", text: element.textContent || "" });
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

  const CANDIDATE_SELECTOR = [
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
  ].join(", ");

  function collectCandidates(root, out) {
    if (root instanceof HTMLElement && safeMatches(root, CANDIDATE_SELECTOR)) out.add(root);
    safeQuerySelectorAll(root, CANDIDATE_SELECTOR).forEach((node) => {
      if (node instanceof HTMLElement) out.add(node);
    });
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
      return { reason: "custom domain rule", category: "custom", evidence: hostRule, source: "page address" };
    }
    const customSource = sourceDomainMatches(element, settings.customDomainRules);
    if (customSource) {
      return { reason: "custom source domain rule", category: "custom", evidence: customSource, source: "link URL" };
    }

    if (settings.blockAds) {
      const adSelector = GENERIC_AD_SELECTORS.find((selector) => safeMatches(element, selector));
      if (adSelector) {
        return { reason: "ad selector", category: "ad", evidence: adSelector, source: "element attributes" };
      }
    }

    for (const rule of getSiteRules()) {
      const category = rule.category || "ai";
      if (category === "ad" ? !settings.blockAds : !settings.blockAiFeatures) continue;
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
      if (match) return { reason: rule.id, category, ...match };
    }

    if (settings.blockAiFeatures) {
      const genericHit = locateEvidence(parts, GENERIC_AI_TEXT_PATTERNS);
      if (genericHit) return { reason: "AI feature text", category: "ai", ...genericHit };

      const customText = findRegexEvidence(parts, text, settings.customTextRules);
      if (customText) return { reason: "custom text rule", category: "custom", ...customText };

      const customSelector = settings.customSelectorRules.find((selector) => safeMatches(element, selector));
      if (customSelector) {
        return { reason: "custom selector rule", category: "custom", evidence: customSelector, source: "element attributes" };
      }
    }

    if (settings.heuristicDetection) {
      const score = scoreAiLikeText(text);
      if (score >= settings.heuristicThreshold) {
        return {
          reason: "AI-like writing pattern",
          category: "ai",
          evidence: `score ${score} (threshold ${settings.heuristicThreshold})`,
          source: "text analysis"
        };
      }
    }

    return null;
  }

  // A page must stay usable even when a rule misfires: media players are
  // never hidden or blurred. Bare <video> tags are only protected when
  // they are the target itself, so promoted tiles that merely contain a
  // preview clip can still be hidden.
  const PLAYER_SELECTOR = "#movie_player, .html5-video-player, .video-js, .jwplayer, [class*='video-player']";

  function isProtectedTarget(target) {
    return safeMatches(target, `video, audio, ${PLAYER_SELECTOR}`)
      || Boolean(target.querySelector(PLAYER_SELECTOR));
  }

  function isClickHijackOverlay(element) {
    if (element.dataset.elarionBlocked === "true") return false;
    const tag = element.tagName;
    if (tag !== "DIV" && tag !== "A" && tag !== "IFRAME") return false;
    if (typeof element.className === "string" && element.className.startsWith("elarion-")) return false;
    // Anything inside or wrapping a media player is off limits: players
    // legitimately use transparent click layers for play/pause.
    if (element.closest(PLAYER_SELECTOR)) return false;
    if (element.querySelector(PLAYER_SELECTOR)) return false;

    const style = getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "absolute") return false;
    if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    const zIndex = parseInt(style.zIndex, 10);
    if (!Number.isFinite(zIndex) || zIndex < 1000) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.4) return false;

    if (parseFloat(style.opacity) <= 0.05) return true;
    // An iframe's contents can't be judged from outside, so iframes only
    // count as hijack overlays when they are truly invisible.
    if (tag === "IFRAME") return false;
    const transparentBg = (style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent")
      && style.backgroundImage === "none";
    const empty = !(element.textContent || "").trim()
      && !element.querySelector("img, svg, video, canvas, iframe, input, button");
    return transparentBg && empty;
  }

  function neutralizeOverlay(element) {
    if (element.dataset.elarionBlocked === "true") return;
    element.dataset.elarionBlocked = "true";
    element.dataset.elarionReason = "click-hijack overlay";
    element.dataset.elarionEvidence = "invisible high z-index layer covering the page";
    element.dataset.elarionSource = "overlay heuristic";
    element.classList.add("elarion-hidden");
    state.blocked += 1;
  }

  function applyAction(element, detail, settings) {
    const info = typeof detail === "string" ? { reason: detail } : detail;
    const action = getEffectiveAction(info.category, settings);
    if (action === "off") return;

    const target = getBlockTarget(element);
    if ((action === "hide" || action === "blur") && isProtectedTarget(target)) return;
    if (target.dataset.elarionBlocked === "true") return;
    target.dataset.elarionBlocked = "true";
    target.dataset.elarionReason = info.reason;
    if (info.evidence) target.dataset.elarionEvidence = info.evidence;
    if (info.source) target.dataset.elarionSource = info.source;

    if (action === "debug") {
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
    } else if (action === "label") {
      target.classList.add("elarion-labeled");
      if (!target.querySelector(":scope > .elarion-label-badge")) {
        const badge = document.createElement("div");
        badge.className = "elarion-label-badge";
        badge.textContent = `Elarion flagged: ${info.reason}`;
        target.prepend(badge);
      }
      state.labeled += 1;
    } else if (action === "blur") {
      target.classList.add("elarion-blurred");
      state.blocked += 1;
    } else {
      hideTarget(target, info);
      state.blocked += 1;
    }
  }

  function hideTarget(target, info) {
    // display:none on absolutely positioned items (masonry grids like
    // Pinterest) leaves a blank hole because siblings never reflow, so
    // those get a neutral cover tile that preserves the layout instead.
    const position = getComputedStyle(target).position;
    if (position !== "absolute" && position !== "fixed") {
      target.classList.add("elarion-hidden");
      return;
    }

    target.classList.add("elarion-tile-hidden");
    if (target.querySelector(":scope > .elarion-cover")) return;

    const cover = document.createElement("div");
    cover.className = "elarion-cover";
    const label = document.createElement("span");
    label.textContent = info.category === "ad" ? "Ad hidden by Elarion" : "Hidden by Elarion";
    const show = document.createElement("button");
    show.type = "button";
    show.textContent = "Show";
    show.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("elarion-tile-hidden");
      cover.remove();
    });
    cover.appendChild(label);
    cover.appendChild(show);
    target.appendChild(cover);
  }

  function scanSelectors(root, settings) {
    const selectorGroups = [];
    if (settings.blockAds) {
      GENERIC_AD_SELECTORS.forEach((selector) => selectorGroups.push({ selector, category: "ad" }));
    }
    getSiteRules()
      .filter((rule) => !rule.selectorRequiresEvidence)
      .forEach((rule) => {
        const category = rule.category || "ai";
        if (category === "ad" ? !settings.blockAds : !settings.blockAiFeatures) return;
        rule.selectors.forEach((selector) => selectorGroups.push({ selector, category }));
      });
    if (settings.blockAiFeatures) {
      settings.customSelectorRules.forEach((selector) => selectorGroups.push({ selector, category: "custom" }));
    }

    selectorGroups.forEach(({ selector, category }) => {
      safeQuerySelectorAll(root, selector).forEach((element) => {
        if (element instanceof HTMLElement) {
          applyAction(element, { reason: selector, category, evidence: selector, source: "element attributes" }, settings);
        }
      });
    });
  }

  function scanPage() {
    if (!state.settings.enabled || isSiteDisabled(state.settings)) {
      state.pendingRoots.clear();
      return;
    }

    // Attribute selectors are cheap, so they always sweep the document;
    // the expensive text extraction only runs on newly added subtrees.
    scanSelectors(document, state.settings);

    // While the parser is still streaming, a candidate's evidence may not
    // exist yet, and scanned elements are never revisited. Candidates wait
    // for DOMContentLoaded, which triggers a full sweep.
    if (document.readyState === "loading") return;

    const candidates = new Set();
    let overlayCandidates = [];
    if (state.needsFullSweep) {
      state.needsFullSweep = false;
      state.pendingRoots.clear();
      safeQuerySelectorAll(document, CANDIDATE_SELECTOR).forEach((node) => {
        if (node instanceof HTMLElement) candidates.add(node);
      });
      overlayCandidates = document.body ? Array.from(document.body.children) : [];
    } else {
      const roots = Array.from(state.pendingRoots);
      state.pendingRoots.clear();
      roots.forEach((root) => {
        if (root.isConnected) collectCandidates(root, candidates);
      });
      overlayCandidates = roots;
    }

    for (const element of candidates) {
      if (state.scanned.has(element)) continue;
      state.scanned.add(element);
      const detail = findReason(element, state.settings);
      if (detail) applyAction(element, detail, state.settings);
    }

    if (state.settings.blockAds && getEffectiveAction("ad", state.settings) !== "off") {
      overlayCandidates.forEach((element) => {
        if (element instanceof HTMLElement && element.isConnected && isClickHijackOverlay(element)) {
          neutralizeOverlay(element);
        }
      });
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
    document.querySelectorAll(".elarion-label-badge, .elarion-debug-badge, .elarion-cover").forEach((node) => node.remove());
    document.querySelectorAll("[data-elarion-blocked]").forEach((element) => {
      element.classList.remove("elarion-hidden", "elarion-blurred", "elarion-labeled", "elarion-debug", "elarion-tile-hidden");
      delete element.dataset.elarionBlocked;
      delete element.dataset.elarionReason;
      delete element.dataset.elarionEvidence;
      delete element.dataset.elarionSource;
    });
    state.scanned = new WeakSet();
    state.blocked = 0;
    state.labeled = 0;
  }

  function onMutations(mutations) {
    let added = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        // Skip Elarion's own badges and covers so applying an action
        // never schedules another scan.
        if (typeof node.className === "string" && node.className.startsWith("elarion-")) continue;
        state.pendingRoots.add(node);
        added = true;
      }
    }
    if (added) queueScan();
  }

  function queueScan() {
    if (state.queued) return;
    state.queued = true;
    window.setTimeout(() => {
      state.queued = false;
      scanPage();
    }, 80);
  }

  function syncInstantHide(settings) {
    // content.css hides unambiguous ad elements from the first paint;
    // this attribute switches that off when hiding them would be wrong.
    const cssHide = settings.enabled
      && settings.blockAds
      && !isSiteDisabled(settings)
      && getEffectiveAction("ad", settings) === "hide";
    document.documentElement.toggleAttribute("data-elarion-ads-off", !cssHide);
  }

  function interceptHijackedEvent(event) {
    const settings = state.settings;
    if (!settings.enabled || !settings.blockAds || isSiteDisabled(settings)) return;
    let element = event.target instanceof HTMLElement ? event.target : null;
    for (let depth = 0; element && element !== document.body && depth < 8; depth += 1) {
      if (isClickHijackOverlay(element)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        neutralizeOverlay(element);
        return;
      }
      element = element.parentElement;
    }
  }

  async function init() {
    // Registered before anything else on the page so hijacked clicks are
    // intercepted even if an overlay appeared milliseconds earlier.
    window.addEventListener("click", interceptHijackedEvent, true);
    window.addEventListener("mousedown", interceptHijackedEvent, true);

    state.settings = await loadSettings();
    syncInstantHide(state.settings);
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        state.needsFullSweep = true;
        scanPage();
      }, { once: true });
    }
    scanPage();

    if (isExtensionContextReady()) {
      chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "ELARION_GET_PAGE_STATS") {
          sendResponse({ blocked: state.blocked, labeled: state.labeled, host: location.hostname });
        }
        if (message?.type === "ELARION_REFRESH") {
          state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
          resetActions();
          state.needsFullSweep = true;
          syncInstantHide(state.settings);
          scanPage();
          sendResponse({ ok: true });
        }
        return true;
      });
    }
  }

  init();
})();
