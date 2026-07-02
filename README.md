# Elarion Blocker

Elarion Blocker is a Manifest V3 browser extension that blocks ads, AI answer panels, AI feature boxes, and low-quality AI-like content using local rules.

It does not claim to reliably detect all AI-generated writing. The MVP focuses on the useful version of the idea: blocking visible AI features and labeling content that matches local heuristic patterns.

## Features

- Chrome Manifest V3 extension
- Content script DOM scanning
- Generic ad selectors
- Site-specific AI feature filters for Google, Bing, LinkedIn, Reddit, Medium, and Pinterest
- Pinterest-specific blocking for promoted pins, sponsored UI, AI-art terms, AI-image generator mentions, and known AI-art source domains
- Local text heuristics for AI-like writing patterns
- Popup controls:
  - Enable or disable globally
  - Hide, blur, or label matches
  - Toggle ad blocking, AI feature blocking, and heuristic detection
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
```

## Notes

Chrome does not support the CSS `:has-text()` pseudo-selector. Elarion safely ignores unsupported selectors and still catches those rules through text-pattern scanning.
