(() => {
  "use strict";

  const knownSites = new Map([
    ["chatgpt", { name: "ChatGPT", url: "https://chatgpt.com/" }],
    ["chat gpt", { name: "ChatGPT", url: "https://chatgpt.com/" }],
    ["youtube", { name: "YouTube", url: "https://www.youtube.com/" }],
    ["national scholarship portal", { name: "National Scholarship Portal", url: "https://scholarships.gov.in/" }],
    ["nsp", { name: "National Scholarship Portal", url: "https://scholarships.gov.in/" }],
    ["google", { name: "Google", url: "https://www.google.com/" }],
    ["gmail", { name: "Gmail", url: "https://mail.google.com/" }],
    ["wikipedia", { name: "Wikipedia", url: "https://www.wikipedia.org/" }]
  ]);

  function makeResponse(message, status, title, text, extra = {}) {
    return { type: "VOICEPILOT_BROWSER_RESPONSE", requestId: message.requestId, status, title, message: text, ...extra };
  }

  function normalize(value) {
    return String(value || "").trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ").toLocaleLowerCase();
  }

  function splitTabMode(target) {
    const match = target.match(/\s+in\s+(?:(?:a|the)\s+)?(new|current|this)\s+tab[.!?]*$/i);
    if (!match) return { target: target.trim(), mode: "new" };
    return {
      target: target.slice(0, match.index).trim(),
      mode: match[1].toLocaleLowerCase() === "new" ? "new" : "current"
    };
  }

  function parseBrowserCommand(command) {
    const text = String(command || "").trim();
    const searchMatch = text.match(/^search\s+google\s+for(?:\s+(.+))?$/i);
    if (searchMatch) {
      const parsed = splitTabMode(searchMatch[1] || "");
      if (!parsed.target) return { error: "Tell me what you want to search for." };
      return { action: "search", query: parsed.target, mode: parsed.mode };
    }

    const openMatch = text.match(/^open(?:\s+(.+))?$/i);
    if (openMatch) {
      const parsed = splitTabMode(openMatch[1] || "");
      if (!parsed.target) return { error: "Tell me which website to open." };

      const site = knownSites.get(normalize(parsed.target).replace(/^the\s+/, ""));
      if (site) return { action: "open", name: site.name, url: site.url, mode: parsed.mode };

      let url;
      try {
        url = new URL(parsed.target);
      } catch (_) {
        return { unknownSite: parsed.target, mode: parsed.mode };
      }
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
        return { error: "Use a normal http:// or https:// website address without embedded credentials." };
      }
      return { action: "open", name: url.hostname, url: url.href, mode: parsed.mode };
    }

    return { error: "Try “open ChatGPT” or “search Google for Java DSA”." };
  }

  async function openDestination(message, parsed) {
    if (parsed.mode === "current") {
      if (!Number.isInteger(message.currentTabId)) {
        return makeResponse(message, "error", "Current tab unavailable", "I could not identify the current tab to navigate.");
      }
      await chrome.tabs.update(message.currentTabId, { url: parsed.url });
      return makeResponse(message, "success", "Opened website", `Opened ${parsed.name} in the current tab.`, { action: "open" });
    }

    await chrome.tabs.create({ url: parsed.url, active: true });
    return makeResponse(message, "success", "Opened website", `Opened ${parsed.name} in a new tab.`, { action: "open" });
  }

  async function handleBrowserCommand(message) {
    if (typeof message.command !== "string") {
      return makeResponse(message, "error", "Invalid command", "The browser command must be text.");
    }

    const parsed = parseBrowserCommand(message.command);
    if (parsed.unknownSite) {
      return makeResponse(
        message,
        "info",
        "Website not recognized",
        `I don't have a verified destination for “${parsed.unknownSite}”. Provide its full https:// address, or use a recognized site name.`
      );
    }
    if (parsed.error) return makeResponse(message, "error", "Could not open destination", parsed.error);

    try {
      if (parsed.action === "search") {
        const searchUrl = new URL("https://www.google.com/search");
        searchUrl.searchParams.set("q", parsed.query);
        return await openDestination(message, { ...parsed, name: "Google search", url: searchUrl.href });
      }
      return await openDestination(message, parsed);
    } catch (_) {
      return makeResponse(message, "error", "Browser action failed", "Chrome could not open that destination. Check the tab and try again.");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "VOICEPILOT_BROWSER_COMMAND") return false;
    if (sender.id !== chrome.runtime.id) {
      sendResponse(makeResponse(message, "error", "Request not allowed", "Only the VoicePilot popup can request browser navigation."));
      return false;
    }

    handleBrowserCommand(message).then(sendResponse).catch(() => {
      sendResponse(makeResponse(message, "error", "Browser action failed", "Chrome could not complete that browser command."));
    });
    return true;
  });
})();