(() => {
  "use strict";

  const pendingFinds = new Map();
  const highlightTimers = new WeakMap();
  const pendingLifetimeMs = 30_000;
  const highlightDurationMs = 3_000;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  function visibleText(element) {
    return normalize(element.innerText || element.textContent);
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && Number(style.opacity) !== 0
      && element.getClientRects().length > 0;
  }

  function searchTarget(element) {
    if (element instanceof HTMLLabelElement && element.control) return element.control;
    return element.closest("a, button, input, textarea, select, [role='button'], [role='link'], label, summary") || element;
  }

  function getAttributeValues(element) {
    const values = [
      element.id,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.getAttribute("name"),
      element.getAttribute("data-testid")
    ];
    if (element.labels) {
      for (const label of element.labels) values.push(label.innerText || label.textContent);
    }
    return values.map(normalize).filter(Boolean);
  }

  function findMatches(target) {
    const wanted = normalize(target);
    const matches = new Map();

    for (const element of document.querySelectorAll("body *")) {
      if (!isVisible(element)) continue;

      const attributes = getAttributeValues(element);
      const text = visibleText(element);
      let score = Infinity;
      let textLength = Infinity;

      if (normalize(element.id) === wanted) score = 0;
      if (attributes.some((value) => value === wanted)) score = Math.min(score, 1);
      if (text === wanted) {
        score = Math.min(score, 2);
        textLength = text.length;
      }
      if (score === Infinity && normalize(element.id).includes(wanted)) score = 3;
      if (score > 3 && attributes.some((value) => value.includes(wanted))) score = 4;
      if (score > 4 && text.includes(wanted)) {
        score = 5;
        textLength = text.length;
      }
      if (!Number.isFinite(score)) continue;

      const candidate = searchTarget(element);
      const existing = matches.get(candidate);
      if (!existing || score < existing.score || (score === 5 && textLength < existing.textLength)) {
        matches.set(candidate, { element: candidate, score, textLength });
      }
    }

    const ranked = [...matches.values()];
    if (!ranked.length) return [];
    const bestScore = Math.min(...ranked.map((match) => match.score));
    let best = ranked.filter((match) => match.score === bestScore);
    if (bestScore === 5) {
      const shortestText = Math.min(...best.map((match) => match.textLength));
      best = best.filter((match) => match.textLength === shortestText);
    }

    return best
      .filter((match) => !best.some((ancestorMatch) => {
        const ancestor = ancestorMatch.element;
        return ancestor !== match.element
          && ancestor.contains(match.element)
          && visibleText(ancestor) === visibleText(match.element);
      }))
      .map((match) => match.element);
  }

  function describe(element) {
    const label = visibleText(element)
      || normalize(element.getAttribute("aria-label"))
      || normalize(element.getAttribute("title"))
      || element.id
      || element.tagName.toLocaleLowerCase();
    return label.length > 100 ? `${label.slice(0, 97)}...` : label;
  }

  function highlight(element) {
    const previousTimer = highlightTimers.get(element);
    if (previousTimer) window.clearTimeout(previousTimer);

    const originalOutline = element.style.getPropertyValue("outline");
    const originalOutlinePriority = element.style.getPropertyPriority("outline");
    const originalOffset = element.style.getPropertyValue("outline-offset");
    const originalOffsetPriority = element.style.getPropertyPriority("outline-offset");
    element.style.setProperty("outline", "3px solid #ff6b35", "important");
    element.style.setProperty("outline-offset", "3px", "important");

    try {
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    } catch (_) {
      element.scrollIntoView();
    }

    const timer = window.setTimeout(() => {
      if (originalOutline) element.style.setProperty("outline", originalOutline, originalOutlinePriority);
      else element.style.removeProperty("outline");
      if (originalOffset) element.style.setProperty("outline-offset", originalOffset, originalOffsetPriority);
      else element.style.removeProperty("outline-offset");
      highlightTimers.delete(element);
    }, highlightDurationMs);
    highlightTimers.set(element, timer);
  }

  function response(status, title, message, extra = {}) {
    return { status, title, message, ...extra };
  }

  function runFind(target, requestId) {
    const query = String(target || "").trim();
    if (!query) return response("error", "Missing search text", "Tell VoicePilot what text or page element to find.");

    const matches = findMatches(query);
    if (!matches.length) {
      return response("error", "No match found", `I could not find a visible page element matching “${query}”.`);
    }
    if (matches.length > 1) {
      if (requestId) {
        pendingFinds.set(requestId, { matches, expiresAt: Date.now() + pendingLifetimeMs });
      }
      const choices = matches.slice(0, 8).map((element, index) => ({ label: describe(element), index }));
      return response("clarification", "Choose a match", `I found ${matches.length} elements matching “${query}”. Choose one to highlight it.`, { choices });
    }

    highlight(matches[0]);
    return response("success", "Match found", `Found and highlighted “${describe(matches[0])}”.`);
  }

  function handleCommand(message) {
    if (message.type === "FIND") return runFind(message.target, message.requestId);

    if (message.type === "VOICEPILOT_COMMAND") {
      const command = String(message.command || "").trim();
      const match = command.match(/^(?:find|locate|search for)\s+(.+)$/i);
      if (!match) {
        return response("error", "Command not supported yet", "This content-script phase supports FIND only. Try “find scholarships”.");
      }
      return runFind(match[1], message.requestId);
    }

    if (message.type === "VOICEPILOT_RESOLVE") {
      const pending = pendingFinds.get(message.requestId);
      pendingFinds.delete(message.requestId);
      if (!pending || pending.expiresAt < Date.now()) {
        return response("error", "Selection expired", "That match selection expired. Send the FIND command again.");
      }
      if (!Number.isInteger(message.choiceIndex) || message.choiceIndex < 0 || message.choiceIndex >= pending.matches.length) {
        return response("error", "Invalid selection", "That match selection is not valid. Send the FIND command again.");
      }
      const element = pending.matches[message.choiceIndex];
      if (!element.isConnected || !isVisible(element)) {
        return response("error", "Match is no longer available", "The selected page element changed. Send the FIND command again.");
      }
      highlight(element);
      return response("success", "Match found", `Found and highlighted “${describe(element)}”.`);
    }

    return null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !["FIND", "VOICEPILOT_COMMAND", "VOICEPILOT_RESOLVE"].includes(message.type)) return false;
    sendResponse(handleCommand(message));
    return false;
  });
})();