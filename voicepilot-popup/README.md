# YAPILOT — VoicePilot popup component

This folder contains Praneeth's popup UI and speech/typed input component. It is deliberately plain HTML, CSS and JavaScript (no build step).

## Files
- `popup.html` — popup UI
- `popup.css` — styling
- `popup.js` — Web Speech API, typed fallback, and messaging to the active tab

## Integration contract

The popup sends these messages to the content script using `chrome.tabs.sendMessage`:

### 1. Run a command
```js
{
  type: "VOICEPILOT_COMMAND",
  requestId: "unique-string",
  command: "click Apply"
}
```

Expected response:
```js
{
  status: "success" | "clarification" | "confirmation" | "error" | "info",
  title?: "Optional short title",
  message: "Human-readable result",
  choices?: [{ label: "Apply — Scholarship A", index: 0 }],
  confirmationToken?: "opaque-one-time-token",
  confirmationMessage?: "Submit this application?"
}
```

### 2. Resolve an ambiguous match
```js
{
  type: "VOICEPILOT_RESOLVE",
  requestId: "same-request-id",
  choiceIndex: 0
}
```
Return the same response shape. Only execute the chosen action after validating the pending request and index on the content-script side.

### 3. Confirm or cancel a sensitive action
```js
{
  type: "VOICEPILOT_CONFIRM",
  requestId: "same-request-id",
  confirmationToken: "opaque-one-time-token",
  confirmed: true
}
```
Use `confirmed: false` for cancellation. The content script must validate the token and request, expire it after use, and never submit/delete anything merely because the original voice command asked for it.

### Suggested Manifest V3 snippet
Merge these fields into the team's manifest; do not replace other teammate settings without coordinating:
```json
{
  "manifest_version": 3,
  "name": "YAPILOT — VoicePilot",
  "version": "1.0.0",
  "description": "Hands-free browsing with safer voice commands.",
  "permissions": ["activeTab"],
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```
If the project already has a manifest, merge only the needed popup and permission settings. The `content.js` filename above is a placeholder for Maha's actual content-script filename.

## Run / test locally
1. Put `popup.html`, `popup.css`, and `popup.js` in the extension root alongside the team's manifest and content script.
2. Merge the manifest settings above, replacing `content.js` with the actual content-script filename if needed.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Select the extension folder. Open a normal `http://` or `https://` webpage and refresh it after loading the extension.
5. Click the extension icon. Test typed commands first; then test the microphone and allow permission if prompted.
6. The popup is integrated only when the content script responds using the message contract above. Without that content script, it will show a connection error rather than pretend a command succeeded.

## Important limitations
- Web Speech API availability and behavior depend on the browser and its speech service; typed commands are the fallback.
- Browser-internal pages (for example, `chrome://extensions`) cannot be controlled.
- The popup intentionally does not execute page actions itself. Matching, highlighting, ambiguity handling and action safety belong in the content script.
