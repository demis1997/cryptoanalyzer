const TARGETS = [
  { host: "chatgpt.com", url: "https://chatgpt.com/" },
  { host: "chat.openai.com", url: "https://chat.openai.com/" }
];

function pickTarget() {
  // Prefer chatgpt.com
  return TARGETS[0];
}

async function openChatGptTab() {
  const t = pickTarget();
  const tab = await chrome.tabs.create({ url: t.url, active: true });
  return tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || msg.type !== "OPEN_AND_SEND" || typeof msg.prompt !== "string") return;
    const prompt = msg.prompt;
    const tab = await openChatGptTab();

    // Wait a bit for the page to load and content script to attach.
    await new Promise((r) => setTimeout(r, 2000));

    // Ping content script; retry for up to ~20s (login/slow loads).
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "PING" });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    await chrome.tabs.sendMessage(tab.id, { type: "PASTE_AND_SEND", prompt });
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));

  return true;
});

