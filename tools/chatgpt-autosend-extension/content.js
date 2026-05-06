function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findComposerTextarea() {
  // ChatGPT UI changes often. We try multiple selectors.
  return (
    document.querySelector('textarea#prompt-textarea') ||
    document.querySelector('textarea[name="prompt"]') ||
    document.querySelector('textarea[placeholder*="Message"]') ||
    document.querySelector("textarea")
  );
}

function findSendButton() {
  // Prefer explicit data-testid when present.
  return (
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[title*="Send"]') ||
    null
  );
}

async function pasteIntoTextarea(textarea, value) {
  textarea.focus();
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

async function clickSend() {
  const btn = findSendButton();
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  // Fallback: Enter to send (works if ChatGPT configured that way)
  const ta = findComposerTextarea();
  if (!ta) return false;
  ta.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
  );
  ta.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  return true;
}

async function pasteAndSend(prompt) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ta = findComposerTextarea();
    if (!ta) {
      await sleep(500);
      continue;
    }
    await pasteIntoTextarea(ta, prompt);
    await sleep(250);
    await clickSend();
    return { ok: true };
  }
  return { ok: false, error: "Timed out waiting for ChatGPT composer textarea." };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg) return;
    if (msg.type === "PING") return sendResponse({ ok: true });
    if (msg.type === "PASTE_AND_SEND") {
      const prompt = String(msg.prompt || "");
      const r = await pasteAndSend(prompt);
      return sendResponse(r);
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;
});

