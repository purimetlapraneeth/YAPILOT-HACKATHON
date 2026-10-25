(() => {
  "use strict";

  const pendingFinds = new Map();
  const pendingClicks = new Map();
  const pendingConfirmations = new Map();
  const highlightTimers = new WeakMap();
  const pendingLifetimeMs = 30_000;
  const highlightDurationMs = 4_000;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  function visibleText(element) {
    return normalize(element.innerText || element.textContent);
  }

  function isVisible(element) {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (ancestor.hidden || ancestor.inert
        || ancestor.getAttribute("aria-hidden") === "true"
        || style.display === "none"
        || style.visibility === "hidden"
        || style.visibility === "collapse"
        || Number(style.opacity) === 0) return false;
    }
    return element.getClientRects().length > 0;
  }

  function isEligible(element) {
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "META", "LINK"].includes(element.tagName)) return false;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    if (element.matches(":disabled") || element.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  function isInteractive(element) {
    return element.matches("a, button, input, textarea, select, summary, [role='button'], [role='link'], [role='option'], [role='checkbox'], [role='radio'], [role='switch']");
  }

  function isActionable(element) {
    return element.matches("button, a[href], area[href], input:not([type='hidden']), select, textarea, summary, [role='button'], [role='link'], [role='option'], [role='checkbox'], [role='radio'], [role='switch']");
  }

  function searchTarget(element) {
    if (element instanceof HTMLLabelElement && element.control) return element.control;
    return element.closest("a, button, input, textarea, select, [role='button'], [role='link'], [role='option'], [role='checkbox'], [role='radio'], [role='switch'], label, summary") || element;
  }

  function getAttributeValues(element) {
    const values = [
      element.id,
      element.getAttribute("aria-label"),
      element.getAttribute("aria-description"),
      element.getAttribute("aria-placeholder"),
      element.getAttribute("aria-valuetext"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.getAttribute("name"),
      element.getAttribute("data-testid")
    ];
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const label = document.getElementById(id);
        if (label) values.push(label.innerText || label.textContent);
      }
    }
    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const description = document.getElementById(id);
        if (description) values.push(description.innerText || description.textContent);
      }
    }
    if (element.labels) {
      for (const label of element.labels) values.push(label.innerText || label.textContent);
    }
    return values.map(normalize).filter(Boolean);
  }

  function matchScore(element, wanted) {
    const attributes = getAttributeValues(element);
    const text = visibleText(element);

    if (attributes.some((value) => value === wanted) || text === wanted) return 0;
    if (attributes.some((value) => value.split(/\s+/).includes(wanted))
      || text.split(/\s+/).includes(wanted)) return 1;
    if (attributes.some((value) => value.includes(wanted)) || text.includes(wanted)) return 2;
    return Infinity;
  }

  function getLabelledByTargets(elements) {
    const targetsByLabelId = new Map();
    for (const element of elements) {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (!labelledBy || !isEligible(element) || !isVisible(element)) continue;
      for (const id of labelledBy.split(/\s+/)) {
        const targets = targetsByLabelId.get(id) || [];
        targets.push(element);
        targetsByLabelId.set(id, targets);
      }
    }
    return targetsByLabelId;
  }

  function findMatches(target, actionableOnly = false, elements = document.querySelectorAll("body *")) {
    const wanted = normalize(target);
    if (!wanted) return [];
    const matches = new Map();
    const labelledByTargets = getLabelledByTargets(elements);

    for (const element of elements) {
      if (!isEligible(element) || !isVisible(element)) continue;

      const score = matchScore(element, wanted);
      if (!Number.isFinite(score)) continue;

      const labelledTargets = element.id ? labelledByTargets.get(element.id) : null;
      const candidates = labelledTargets?.length ? labelledTargets : [searchTarget(element)];
      for (const candidate of candidates) {
        if (!isEligible(candidate) || !isVisible(candidate)) continue;
        if (actionableOnly && !isActionable(candidate)) continue;
        const existing = matches.get(candidate);
        const candidateTextLength = visibleText(candidate).length;
        if (!existing || score < existing.score || (score === existing.score && candidateTextLength < existing.textLength)) {
          matches.set(candidate, {
            element: candidate,
            score,
            textLength: candidateTextLength,
            interactive: isInteractive(candidate)
          });
        }
      }
    }

    const ranked = [...matches.values()];
    if (!ranked.length) return [];
    const bestScore = Math.min(...ranked.map((match) => match.score));
    let best = ranked.filter((match) => match.score === bestScore);
    if (bestScore > 0) {
      const shortestText = Math.min(...best.map((match) => match.textLength));
      best = best.filter((match) => match.textLength === shortestText);
    }

    return best
      .filter((match) => !best.some((descendantMatch) => {
        const descendant = descendantMatch.element;
        return descendant !== match.element && match.element.contains(descendant)
          && ((descendantMatch.interactive && !match.interactive)
            || (visibleText(match.element) === visibleText(descendant)
              && descendantMatch.interactive !== match.interactive));
      }))
      .map((match) => match.element);
  }

  function headingLevel(element) {
    const tagLevel = element.tagName.match(/^H([1-6])$/);
    if (tagLevel) return Number(tagLevel[1]);
    return Number(element.getAttribute("aria-level")) || 6;
  }

  function isHeading(element) {
    return /^H[1-6]$/.test(element.tagName) || element.getAttribute("role") === "heading";
  }

  function findHeadings(target, elements) {
    const wanted = normalize(target);
    const matches = elements
      .filter((element) => isHeading(element) && isEligible(element) && isVisible(element))
      .map((element) => ({ element, score: matchScore(element, wanted) }))
      .filter((match) => Number.isFinite(match.score));
    if (!matches.length) return [];

    const bestScore = Math.min(...matches.map((match) => match.score));
    const best = matches.filter((match) => match.score === bestScore);
    return bestScore === 0
      ? best.map((match) => match.element)
      : best.sort((first, second) => visibleText(first.element).length - visibleText(second.element).length)
        .filter((match, index, all) => visibleText(match.element).length === visibleText(all[0].element).length)
        .map((match) => match.element);
  }

  function getHeadingSection(heading, elements) {
    const start = elements.indexOf(heading);
    if (start < 0) return [];
    const level = headingLevel(heading);
    let end = elements.length;
    for (let index = start + 1; index < elements.length; index += 1) {
      if (isHeading(elements[index]) && headingLevel(elements[index]) <= level) {
        end = index;
        break;
      }
    }
    return elements.slice(start + 1, end);
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
    const previousHighlight = highlightTimers.get(element);
    if (previousHighlight) window.clearTimeout(previousHighlight.timer);

    const originalStyles = previousHighlight ? previousHighlight.originalStyles : {
      outline: [element.style.getPropertyValue("outline"), element.style.getPropertyPriority("outline")],
      outlineOffset: [element.style.getPropertyValue("outline-offset"), element.style.getPropertyPriority("outline-offset")],
      backgroundColor: [element.style.getPropertyValue("background-color"), element.style.getPropertyPriority("background-color")]
    };
    element.style.setProperty("outline", "3px solid #ff00ff", "important");
    element.style.setProperty("outline-offset", "3px", "important");
    element.style.setProperty("background-color", "rgba(255, 214, 0, 0.22)", "important");

    try {
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    } catch (_) {
      element.scrollIntoView();
    }

    const timer = window.setTimeout(() => {
      const [originalOutline, originalOutlinePriority] = originalStyles.outline;
      const [originalOffset, originalOffsetPriority] = originalStyles.outlineOffset;
      const [originalBackgroundColor, originalBackgroundColorPriority] = originalStyles.backgroundColor;
      if (originalOutline) element.style.setProperty("outline", originalOutline, originalOutlinePriority);
      else element.style.removeProperty("outline");
      if (originalOffset) element.style.setProperty("outline-offset", originalOffset, originalOffsetPriority);
      else element.style.removeProperty("outline-offset");
      if (originalBackgroundColor) element.style.setProperty("background-color", originalBackgroundColor, originalBackgroundColorPriority);
      else element.style.removeProperty("background-color");
      highlightTimers.delete(element);
    }, highlightDurationMs);
    highlightTimers.set(element, { timer, originalStyles });
  }

  function response(status, title, message, extra = {}) {
    return { status, title, message, ...extra };
  }

  function runFind(target, requestId, headingTarget = null, selectedHeading = null) {
    const query = String(target || "").trim();
    if (!query) return response("error", "Missing search text", "Tell VoicePilot what text or page element to find.");

    const pageElements = Array.from(document.querySelectorAll("body *"));
    let searchElements = pageElements;
    if (selectedHeading) {
      searchElements = getHeadingSection(selectedHeading, pageElements);
      if (!searchElements.length) {
        return response("error", "Heading section unavailable", "I could not search that heading section. Try a different heading.");
      }
    } else if (headingTarget) {
      const headings = findHeadings(headingTarget, pageElements);
      if (!headings.length) {
        return response("error", "Heading not found", `I could not find a visible heading named “${headingTarget}”.`);
      }
      if (headings.length > 1) {
        if (requestId) {
          pendingFinds.set(requestId, {
            matches: headings,
            findTarget: query,
            expiresAt: Date.now() + pendingLifetimeMs
          });
        }
        const choices = headings.slice(0, 8).map((element, index) => ({
          label: `Heading “${describe(element)}” (${index + 1})`,
          index
        }));
        return response("clarification", "Choose a heading", `I found multiple “${headingTarget}” headings. Choose the section to search.`, { choices });
      }
      searchElements = getHeadingSection(headings[0], pageElements);
      if (!searchElements.length) {
        return response("error", "Heading section unavailable", `I could not find content under “${headingTarget}”.`);
      }
    }

    const matches = findMatches(query, false, searchElements);
    if (!matches.length) {
      const context = headingTarget ? ` under the “${headingTarget}” heading` : "";
      return response("error", "No match found", `I could not find a visible page element matching “${query}”${context}.`);
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

  function runScroll(destination) {
    try {
      if (destination === "top") {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return response("success", "Page scrolled", "Scrolled to the top of the page.");
      }
      if (destination === "bottom") {
        const documentHeight = Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        window.scrollTo({ top: documentHeight, behavior: "smooth" });
        return response("success", "Page scrolled", "Scrolled to the bottom of the page.");
      }

      const distance = Math.max(100, Math.round(window.innerHeight * 0.8));
      window.scrollBy({
        top: destination === "down" ? distance : -distance,
        left: 0,
        behavior: "smooth"
      });
      return response("success", "Page scrolled", `Scrolled ${destination} by about ${distance} pixels.`);
    } catch (_) {
      return response("error", "Could not scroll", "The page did not allow VoicePilot to scroll.");
    }
  }

  function isSensitiveAction(element) {
    const type = normalize(element.getAttribute("type") || element.type);
    const form = element.form || element.closest("form");
    const submitsForm = Boolean(form)
      && ((element.tagName === "BUTTON" && (!type || type === "submit"))
        || (element.tagName === "INPUT" && ["submit", "image"].includes(type)));
    if (submitsForm) return true;

    const actionText = [
      describe(element),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("value"),
      element.getAttribute("formaction"),
      element.getAttribute("href"),
      element.getAttribute("data-action")
    ].map(normalize).join(" ");
    return /\b(submit|delete|remove|payment|pay|checkout|purchase|buy|confirm|finali[sz]e|place order|transfer|erase|unsubscribe|publish|send application|cancel subscription)\b/i.test(actionText);
  }

  function makeConfirmationToken() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (!globalThis.crypto?.getRandomValues) return null;
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function expireConfirmation(requestId, pending) {
    pending.expirationTimer = window.setTimeout(() => {
      if (pendingConfirmations.get(requestId) !== pending) return;
      if (pending.state === "pending") {
        pending.state = "expired";
        pending.action = null;
      }
      pending.cleanupTimer = window.setTimeout(() => {
        if (pendingConfirmations.get(requestId) === pending) pendingConfirmations.delete(requestId);
      }, pendingLifetimeMs);
    }, pendingLifetimeMs);
  }

  function clickElement(element, requestId) {
    if (!element.isConnected || !isEligible(element) || !isVisible(element) || !isActionable(element)) {
      return response("error", "Element is no longer available", "That page element is hidden, disabled, or no longer actionable.");
    }

    if (isSensitiveAction(element)) {
      if (typeof requestId !== "string" || !requestId.trim()) {
        return response("error", "Confirmation unavailable", "A request ID is required before this sensitive action can be confirmed.");
      }
      if (pendingConfirmations.has(requestId)) {
        return response("error", "Duplicate request", "This request ID already has a pending or recently completed confirmation.");
      }
      const token = makeConfirmationToken();
      if (!token) {
        return response("error", "Confirmation unavailable", "Secure confirmation tokens are unavailable, so no action was taken.");
      }
      const pending = {
        action: { type: "click", element },
        requestId,
        token,
        expiresAt: Date.now() + pendingLifetimeMs,
        state: "pending"
      };
      pendingConfirmations.set(requestId, pending);
      expireConfirmation(requestId, pending);
      const confirmationMessage = `“${describe(element)}” may submit a form or perform a sensitive action. Do you want to continue?`;
      return response("confirmation", "Confirm sensitive action", confirmationMessage, {
        confirmationToken: token,
        confirmationMessage
      });
    }

    try {
      element.click();
      return response("success", "Click completed", `Clicked “${describe(element)}”.`);
    } catch (_) {
      return response("error", "Could not click element", "The page did not allow VoicePilot to click that element.");
    }
  }

  function runClick(target, requestId) {
    const query = String(target || "").trim();
    if (!query) return response("error", "Missing click target", "Tell VoicePilot which button or link to click.");

    const matches = findMatches(query, true);
    if (!matches.length) {
      return response("error", "No actionable match found", `I could not find a visible, enabled button, link, or form control matching “${query}”.`);
    }
    if (matches.length > 1) {
      if (requestId) {
        if (pendingClicks.has(requestId)) {
          return response("error", "Duplicate request", "This request ID already has a pending click selection.");
        }
        pendingClicks.set(requestId, { matches, expiresAt: Date.now() + pendingLifetimeMs });
      }
      const choices = matches.slice(0, 8).map((element, index) => ({ label: describe(element), index }));
      return response("clarification", "Choose an element", `I found ${matches.length} actionable elements matching “${query}”. Choose one before I click.`, { choices });
    }
    return clickElement(matches[0], requestId);
  }

  function resolveClick(message) {
    const pending = pendingClicks.get(message.requestId);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingClicks.delete(message.requestId);
      return response("error", "Selection expired", "That click selection expired. Send the command again.");
    }
    if (!Number.isInteger(message.choiceIndex) || message.choiceIndex < 0 || message.choiceIndex >= pending.matches.length) {
      return response("error", "Invalid selection", "That click selection is not valid. Send the command again.");
    }
    pendingClicks.delete(message.requestId);
    return clickElement(pending.matches[message.choiceIndex], message.requestId);
  }

  function confirmClick(message) {
    if (typeof message.requestId !== "string" || !message.requestId.trim()
      || typeof message.confirmationToken !== "string"
      || typeof message.confirmed !== "boolean") {
      return response("error", "Invalid confirmation", "The request ID, confirmation token, and decision are required.");
    }

    const pending = pendingConfirmations.get(message.requestId);
    if (!pending) {
      return response("error", "No pending confirmation", "That confirmation is missing, expired, or already used.");
    }
    if (message.confirmationToken !== pending.token) {
      return response("error", "Invalid confirmation token", "That token does not match the pending action.");
    }
    if (pending.state !== "pending") {
      return response("error", "Confirmation already used", "That confirmation has already been approved, cancelled, or expired.");
    }
    if (pending.expiresAt <= Date.now()) {
      pending.state = "expired";
      pending.action = null;
      return response("error", "Confirmation expired", "That confirmation expired. Send the command again.");
    }

    if (message.confirmed === false) {
      pending.state = "cancelled";
      pending.action = null;
      return response("info", "Action cancelled", "The sensitive action was not performed.");
    }

    const action = pending.action;
    pending.state = "approved";
    pending.action = null;
    if (!action || action.type !== "click") {
      return response("error", "Action unavailable", "The pending action is not available, so nothing was executed.");
    }
    const { element } = action;
    if (!element.isConnected || !isEligible(element) || !isVisible(element) || !isActionable(element)) {
      return response("error", "Element is no longer available", "The page element changed before confirmation, so no action was taken.");
    }
    try {
      element.click();
      return response("success", "Click completed", `Confirmed and clicked “${describe(element)}”.`);
    } catch (_) {
      return response("error", "Could not click element", "The page did not allow VoicePilot to click that element.");
    }
  }

  function handleCommand(message) {
    if (message.type === "FIND") return runFind(message.target, message.requestId);

    if (message.type === "VOICEPILOT_COMMAND") {
      const command = String(message.command || "").trim();
      const clickMatch = command.match(/^click\s+(.+)$/i);
      if (clickMatch) return runClick(clickMatch[1], message.requestId);

      const headingFindMatch = command.match(/^(?:find|locate|search for)\s+(.+?)\s+(?:under|within|beneath)\s+(?:the\s+)?(.+?)\s+heading$/i);
      if (headingFindMatch) return runFind(headingFindMatch[1], message.requestId, headingFindMatch[2]);

      const scrollMatch = command.match(/^(?:scroll\s+(down|up|to\s+top|to\s+bottom)|go\s+to\s+(?:the\s+)?(top|bottom))$/i);
      if (scrollMatch) {
        const destination = (scrollMatch[1] || scrollMatch[2]).toLocaleLowerCase().replace(/^to\s+/, "");
        return runScroll(destination);
      }
      if (/^(?:scroll|go\s+to)(?:\s|$)/i.test(command)) {
        return response("error", "Unclear scroll command", "Try “scroll down”, “scroll up”, “scroll to top”, or “scroll to bottom”.");
      }
      if (/^(?:fill|enter|type)\b/i.test(command)) {
        return response("info", "Form filling not implemented", "VoicePilot does not fill form fields yet. No field was changed.");
      }
      if (/^(?:submit|send|delete|remove|pay|purchase)\b/i.test(command)) {
        return response("error", "Action not performed", "This consequential action is not implemented. Nothing was submitted, sent, deleted, or purchased.");
      }
      if (/^(?:show|list)\b.*\btabs\b|^switch\s+to\b/i.test(command)) {
        return response("info", "Tab commands not implemented", "Tab listing and switching are not available yet. No tabs were changed.");
      }

      const match = command.match(/^(?:find|locate|search for)\s+(.+)$/i);
      if (!match) {
        return response("error", "Command not supported yet", "Try “find scholarships”, “scroll down”, or “click Apply”.");
      }
      return runFind(match[1], message.requestId);
    }

    if (message.type === "VOICEPILOT_RESOLVE") {
      if (pendingClicks.has(message.requestId)) return resolveClick(message);
      const pending = pendingFinds.get(message.requestId);
      pendingFinds.delete(message.requestId);
      if (!pending || pending.expiresAt < Date.now()) {
        return response("error", "Selection expired", "That match selection expired. Send the FIND command again.");
      }
      if (!Number.isInteger(message.choiceIndex) || message.choiceIndex < 0 || message.choiceIndex >= pending.matches.length) {
        return response("error", "Invalid selection", "That match selection is not valid. Send the FIND command again.");
      }
      const element = pending.matches[message.choiceIndex];
      if (pending.findTarget) return runFind(pending.findTarget, message.requestId, null, element);
      if (!element.isConnected || !isVisible(element)) {
        return response("error", "Match is no longer available", "The selected page element changed. Send the FIND command again.");
      }
      highlight(element);
      return response("success", "Match found", `Found and highlighted “${describe(element)}”.`);
    }

    if (message.type === "VOICEPILOT_CONFIRM") return confirmClick(message);

    return null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !["FIND", "VOICEPILOT_COMMAND", "VOICEPILOT_RESOLVE", "VOICEPILOT_CONFIRM"].includes(message.type)) return false;
    sendResponse(handleCommand(message));
    return false;
  });
})();