// Runs in the page's MAIN world at document_start, before any page script,
// so pop-under code always sees the wrapped window.open. Enforcement is
// controlled by the isolated-world content script through the
// data-elarion-popup-guard attribute on <html>.
(function elarionPopupGuard() {
  const nativeOpen = window.open.bind(window);

  // Pop-up flows real sites depend on: sign-in and checkout windows.
  // Ad pop-unders never target these origins.
  const ALLOWED_POPUP_DOMAINS = [
    "accounts.google.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "login.live.com",
    "github.com",
    "facebook.com",
    "discord.com",
    "id.twitch.tv",
    "paypal.com",
    "checkout.stripe.com"
  ];

  function guardActive() {
    return document.documentElement.dataset.elarionPopupGuard === "on";
  }

  function isAllowedPopup(url) {
    const host = url.hostname.toLowerCase();
    return ALLOWED_POPUP_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  // Pop-under scripts fall back to hijacking the current tab when
  // window.open returns null, so blocked calls get a convincing dummy.
  function fakeWindow() {
    const noop = () => {};
    return {
      closed: false,
      opener: null,
      close: noop,
      focus: noop,
      blur: noop,
      moveTo: noop,
      moveBy: noop,
      resizeTo: noop,
      resizeBy: noop,
      print: noop,
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop,
      document: { write: noop, writeln: noop, open: noop, close: noop },
      location: { href: "about:blank", assign: noop, replace: noop, reload: noop }
    };
  }

  window.open = function open(url, target, features) {
    if (!guardActive()) return nativeOpen(url, target, features);

    let resolved = null;
    try {
      resolved = new URL(url ? String(url) : "about:blank", location.href);
    } catch {
      resolved = null;
    }
    // Same-origin pop-ups stay allowed; everything else (including
    // about:blank, the classic open-then-navigate pop-under trick) is
    // swallowed.
    const webUrl = resolved && (resolved.protocol === "http:" || resolved.protocol === "https:");
    if (webUrl && (resolved.origin === location.origin || isAllowedPopup(resolved))) {
      return nativeOpen(url, target, features);
    }

    document.documentElement.dispatchEvent(new CustomEvent("elarion-popup-blocked"));
    return fakeWindow();
  };
})();
