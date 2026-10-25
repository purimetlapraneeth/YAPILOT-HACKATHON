/* YAPILOT VoicePilot popup
 * Message contract is documented in README.md.
 * Speech recognition is a convenience layer; typed commands always remain available.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const commandInput = $("commandInput");
  const sendButton = $("sendButton");
  const micButton = $("micButton");
  const micButtonText = $("micButtonText");
  const transcriptText = $("transcriptText");
  const speechSupport = $("speechSupport");
  const statusIcon = $("statusIcon");
  const statusTitle = $("statusTitle");
  const statusMessage = $("statusMessage");
  const choiceSection = $("choiceSection");
  const choiceList = $("choiceList");
  const confirmationSection = $("confirmationSection");
  const confirmationText = $("confirmationText");
  const confirmButton = $("confirmButton");
  const cancelButton = $("cancelButton");

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let pendingConfirmation = null;
  let activeRequestId = null;

  const makeRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function setStatus(title, message, kind = "info") {
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    statusIcon.className = "status-icon";
    statusIcon.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : kind === "warning" ? "?" : "✦";
    if (kind === "success" || kind === "error" || kind === "warning") statusIcon.classList.add(kind);
  }

  function hideFollowUps() {
    choiceSection.classList.add("hidden");
    confirmationSection.classList.add("hidden");
    choiceList.replaceChildren();
    pendingConfirmation = null;
  }

  function setBusy(busy) {
    sendButton.disabled = busy;
    commandInput.disabled = busy;
    sendButton.textContent = busy ? "…" : "➜";
  }

  async function getActiveTab() {
    if (!globalThis.chrome?.tabs?.query) {
      throw new Error("Chrome extension APIs are unavailable. Load this page as an unpacked extension.");
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") throw new Error("No active browser tab was found.");
    if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
      throw new Error("VoicePilot cannot control this browser page. Open a regular website and try again.");
    }
    return tab;
  }

  async function getCurrentTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") throw new Error("No current browser tab was found.");
    return tab.id;
  }

  async function sendToPage(message) {
    const tab = await getActiveTab();
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error("Could not reach VoicePilot on this page. Refresh the webpage and check that the content script is loaded."));
          return;
        }
        if (!response) {
          reject(new Error("The page did not return a response. Check that the content script is integrated."));
          return;
        }
        resolve(response);
      });
    });
  }

  async function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error("Could not reach VoicePilot's browser command handler. Reload the extension and try again."));
          return;
        }
        if (!response) {
          reject(new Error("Chrome did not return a response for that browser command."));
          return;
        }
        resolve(response);
      });
    });
  }

  function isBrowserCommand(command) {
    return /^(?:open\b|search\s+google\b)/i.test(command);
  }

  function renderResponse(response, requestId) {
    const status = response.status || "info";
    const message = response.message || "The page responded without a message.";
    const titleByStatus = {
      success: "Command completed",
      clarification: "Choose a match",
      confirmation: "Your confirmation is needed",
      error: "Could not complete command",
      info: "VoicePilot response"
    };
    setStatus(response.title || titleByStatus[status] || "VoicePilot response", message, status === "success" ? "success" : status === "error" ? "error" : status === "clarification" || status === "confirmation" ? "warning" : "info");

    if (status === "clarification" && Array.isArray(response.choices) && response.choices.length) {
      choiceSection.classList.remove("hidden");
      response.choices.forEach((choice, position) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice-button";
        button.textContent = choice.label || `Option ${position + 1}`;
        button.addEventListener("click", () => resolveChoice(requestId, Number.isInteger(choice.index) ? choice.index : position));
        choiceList.appendChild(button);
      });
    }

    if (status === "confirmation") {
      const token = response.confirmationToken;
      if (!token) {
        setStatus("Confirmation unavailable", "The page did not provide a confirmation token, so no action was taken.", "error");
        return;
      }
      pendingConfirmation = { requestId, token };
      confirmationText.textContent = response.confirmationMessage || message;
      confirmationSection.classList.remove("hidden");
    }
  }

  async function submitCommand(rawCommand) {
    const command = String(rawCommand || "").trim();
    if (!command) {
      setStatus("Enter a command", "Speak or type something like “find scholarships”.", "warning");
      commandInput.focus();
      return;
    }
    hideFollowUps();
    activeRequestId = makeRequestId();
    transcriptText.textContent = command;
    setBusy(true);
    const useBrowserHandler = isBrowserCommand(command);
    setStatus("Working on it…", useBrowserHandler ? "Sending a browser navigation command to Chrome." : "Sending your command to the active webpage.");
    try {
      const response = useBrowserHandler
        ? await sendToBackground({
          type: "VOICEPILOT_BROWSER_COMMAND",
          requestId: activeRequestId,
          command,
          currentTabId: await getCurrentTabId()
        })
        : await sendToPage({
          type: "VOICEPILOT_COMMAND",
          requestId: activeRequestId,
          command
        });
      renderResponse(response, activeRequestId);
    } catch (error) {
      setStatus("Page connection failed", error.message || "Unable to send command to the page.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function resolveChoice(requestId, choiceIndex) {
    hideFollowUps();
    setStatus("Resolving selection…", "Asking the webpage to use the selected match.");
    try {
      const response = await sendToPage({
        type: "VOICEPILOT_RESOLVE",
        requestId,
        choiceIndex
      });
      renderResponse(response, requestId);
    } catch (error) {
      setStatus("Selection failed", error.message || "Unable to resolve this selection.", "error");
    }
  }

  confirmButton.addEventListener("click", async () => {
    if (!pendingConfirmation) return;
    const pending = pendingConfirmation;
    hideFollowUps();
    setStatus("Confirming action…", "Sending your explicit confirmation.");
    try {
      const response = await sendToPage({
        type: "VOICEPILOT_CONFIRM",
        requestId: pending.requestId,
        confirmationToken: pending.token,
        confirmed: true
      });
      renderResponse(response, pending.requestId);
    } catch (error) {
      setStatus("Confirmation failed", error.message || "Unable to confirm the action.", "error");
    }
  });

  cancelButton.addEventListener("click", async () => {
    const pending = pendingConfirmation;
    hideFollowUps();
    if (!pending) {
      setStatus("Action cancelled", "No action was confirmed.", "info");
      return;
    }
    try {
      const response = await sendToPage({
        type: "VOICEPILOT_CONFIRM",
        requestId: pending.requestId,
        confirmationToken: pending.token,
        confirmed: false
      });
      renderResponse(response, pending.requestId);
    } catch (_) {
      setStatus("Action cancelled", "No confirmation was sent. The action should remain unexecuted.", "info");
    }
  });

  sendButton.addEventListener("click", () => submitCommand(commandInput.value));
  commandInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCommand(commandInput.value);
    }
  });

  function stopListening() {
    if (recognition && listening) {
      try { recognition.stop(); } catch (_) { /* already stopped */ }
    }
    listening = false;
    micButton.classList.remove("listening");
    micButtonText.textContent = "Start speaking";
  }

  if (!SpeechRecognition) {
    speechSupport.textContent = "Speech unavailable — type instead";
    micButton.title = "Speech recognition is not supported in this browser.";
    micButton.addEventListener("click", () => {
      setStatus("Use typed commands", "Speech recognition is unavailable in this browser. Type your command above.", "warning");
      commandInput.focus();
    });
  } else {
    speechSupport.textContent = "Microphone available";
    micButton.addEventListener("click", () => {
      if (listening) {
        stopListening();
        return;
      }
      try {
        recognition = new SpeechRecognition();
        recognition.lang = "en-IN";
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
          listening = true;
          micButton.classList.add("listening");
          micButtonText.textContent = "Listening… click to stop";
          transcriptText.textContent = "Listening for your command…";
          setStatus("Listening", "Speak clearly. Your command will be shown before it is sent.", "info");
        };

        recognition.onresult = (event) => {
          let interim = "";
          let finalText = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const text = event.results[i][0]?.transcript || "";
            if (event.results[i].isFinal) finalText += text;
            else interim += text;
          }
          transcriptText.textContent = (finalText || interim || "Listening…").trim();
          if (finalText.trim()) {
            commandInput.value = finalText.trim();
            stopListening();
            submitCommand(finalText.trim());
          }
        };

        recognition.onerror = (event) => {
          stopListening();
          const reason = event.error === "not-allowed"
            ? "Microphone permission was denied. Allow microphone access or type a command."
            : event.error === "no-speech"
              ? "No speech was detected. Try again or type a command."
              : `Speech recognition error: ${event.error}. You can type the command instead.`;
          setStatus("Speech input stopped", reason, "warning");
        };

        recognition.onend = () => {
          listening = false;
          micButton.classList.remove("listening");
          micButtonText.textContent = "Start speaking";
        };

        recognition.start();
      } catch (error) {
        stopListening();
        setStatus("Could not start microphone", error.message || "Check browser microphone permissions, or type a command.", "error");
      }
    });
  }

  // Give the user a useful starting state even before the content script is contacted.
  setStatus("Ready when you are", "Open a webpage, then speak or type a command.");
})();
