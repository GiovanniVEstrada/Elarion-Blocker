# Elarion Blocker

Elarion Blocker is a Manifest V3 browser extension that blocks ads, AI answer panels, AI feature boxes, and low-quality AI-like content using local rules.

It does not claim to reliably detect all AI-generated writing. The MVP focuses on the useful version of the idea: blocking visible AI features and labeling content that matches local heuristic patterns.

## Features

- Chrome Manifest V3 extension
- Content script DOM scanning
- Generic ad selectors
- Network-level ad blocking with `declarativeNetRequest`: third-party requests to known ad-serving domains (DoubleClick, Google Syndication, Rubicon Project, Flashtalking, Criteo, Taboola, Outbrain, and others) are blocked before they load; sites on the allowlist or disabled list are excluded
- Site-specific AI feature filters for Google, Bing, LinkedIn, Reddit, Medium, and Pinterest
- Site-specific ad filters for YouTube (display ads, in-feed promoted videos, masthead, companion slots). In-stream video ads are not blocked: they play inside the protected player, and removing them requires techniques outside this extension's scope
- Media players (YouTube's player, video-js, JW Player, plain video/audio tags) are never hidden or blurred, even when an ad rule matches them or their container
- Twitch: display/promoted directory ads are hidden, and during a stream ad break the player is muted and covered with a calm "Ad break" panel until it ends. Twitch stitches video ads into the stream server-side, so the ad still plays underneath — Elarion hides and silences it rather than removing it, and does not use stream-swapping proxies
- Pinterest-specific blocking for promoted pins, sponsored UI, AI-art terms, AI-image generator mentions, and known AI-art source domains
- Local text heuristics for AI-like writing patterns
- Click-hijack protection: invisible high-z-index overlays that steal clicks to open pop-up ads (common on streaming sites) are detected and removed, and a first-in-line click interceptor swallows a hijacked click even when an overlay respawns right before it; pop-under ad networks (PropellerAds, PopAds, PopCash, Adsterra, HilltopAds, ExoClick, and others) are blocked at the network level
- Pop-up blocking everywhere: a main-world wrapper around `window.open` swallows cross-origin pop-ups on every site and hands the ad script a fake window so it does not fall back to hijacking the current tab. Well-known sign-in and checkout windows (Google, Apple, Microsoft, GitHub, Facebook, Discord, Twitch, PayPal, Stripe) stay allowed, and allowlisted or disabled sites are exempt. The per-site "Strict pop-up guard" additionally blocks cross-origin link clicks on hostile sites, and arms itself automatically when a click-hijack overlay is caught
- Fake install/scam interstitials — full-page "Attention: please activate X" dialogs injected by streaming-site ad scripts — are recognized by their wording on oversized overlays and removed together with their dimming backdrop
- Built for speed: unambiguous ad elements are hidden by pure CSS before the first paint, the scanner starts at `document_start`, and after the initial pass it only deep-scans newly added content instead of re-walking the whole page — so infinite feeds stay smooth
- Layout-aware hiding: elements in normal page flow collapse as usual, but absolutely positioned tiles (like Pinterest's masonry grid) are replaced with a quiet "Hidden by Elarion" cover and a Show button — feeds never show blank holes or shifted layouts, and any hidden tile can be revealed in place
- Per-site presets: ads and AI content each get their own action (hide, blur, label, off, or the global default) per site. Shipped defaults: Pinterest labels AI pins and hides ad pins; Google and Bing hide AI answer boxes; Reddit and Medium label AI content; LinkedIn hides AI tools. Sites whose preset keeps ads visible are also excluded from network-level ad blocking.
- Popup controls:
  - Enable or disable globally
  - Hide, blur, or label matches
  - Toggle ad blocking, ad network blocking, AI feature blocking, and heuristic detection
  - Set the current site's per-category actions ("This site": Ads / AI content)
  - Debug overlay that shows each match with its reason, the evidence that matched, and where the evidence was found (visible text, image alt text, link URL, and so on) without hiding anything
  - Disable on current site
- Options page:
  - Allowlist
  - Disabled sites
  - Custom CSS selectors
  - Custom text regex rules
  - Custom blocked domains

## Pinterest Blocking

Pinterest gets special handling because useful signals often live inside pin metadata rather than visible text. Elarion scans pin cards, image alt text, aria labels, titles, and outbound links. It blocks or labels a pin when it finds evidence such as:

- `Promoted` or `Sponsored` ad labels
- AI terms like `AI generated`, `AI art`, `Midjourney`, `Stable Diffusion`, `DALL-E`, `Leonardo AI`, or `ComfyUI`
- Links to common AI-art source domains such as `civitai.com`, `openart.ai`, `lexica.art`, and `nightcafe.studio`

## Install Locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.

## Testing

`test-fixtures/pinterest.html` is a local page of fake pin cards for tuning Pinterest rules against stable markup instead of the live site:

1. In `chrome://extensions`, open Elarion's details and enable **Allow access to file URLs**.
2. Leave settings at their defaults — the built-in Pinterest preset hides ad pins and labels AI pins.
3. Open the fixture file in Chrome and compare each card against its EXPECT chip.

The masonry strip on the fixture mimics Pinterest's absolutely positioned grid: its promoted tile should become a neutral cover with a Show button rather than a blank hole, and the neighboring tiles must not move.

The fixture impersonates `www.pinterest.com` through a `<meta name="elarion-host-override">` tag. The content script honors that tag only on `file:` pages, so remote sites cannot use it.

## Project Structure

```text
manifest.json
src/
  background.js
  content.css
  content.js
  defaults.js
  options.html
  options.js
  popup.html
  popup.js
  ui.css
test-fixtures/
  pinterest.html
```

## Notes

Chrome does not support the CSS `:has-text()` pseudo-selector. Elarion safely ignores unsupported selectors and still catches those rules through text-pattern scanning.
