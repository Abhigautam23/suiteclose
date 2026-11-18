// SuiteClose website assistant widget. Talks to /api/chat (netlify/functions/chat.mjs).
(function () {
  const ENDPOINT = "/api/chat";
  const GREETING =
    "Hi — I'm SuiteClose's AI assistant. What's the biggest headache in your NetSuite reporting or month-end close right now?";
  const STORE = "sc-chat-v1";

  let state = { open: false, messages: [{ role: "assistant", content: GREETING }], handoffSent: false };
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) || "null");
    if (saved && Array.isArray(saved.messages)) state = { ...state, ...saved };
  } catch (e) {}
  const save = () => {
    try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Render plain text with clickable links to this site only.
  function renderText(node, text) {
    const re = /(https:\/\/suiteclose\.co\.uk[^\s)]*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = el("a", null, m[1].replace("https://suiteclose.co.uk", "") || "/");
      a.href = m[1].replace("https://suiteclose.co.uk", "") || "/";
      node.appendChild(a);
      last = m.index + m[1].length;
    }
    node.appendChild(document.createTextNode(text.slice(last)));
  }

  const launcher = el("button", "scc-launcher", "Ask a question");
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");

  const panel = el("div", "scc-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "SuiteClose assistant");
  const head = el("div", "scc-head");
  const title = el("div", "scc-title");
  title.appendChild(el("strong", null, "SuiteClose assistant"));
  title.appendChild(el("span", null, "AI · a person follows up on every enquiry"));
  const close = el("button", "scc-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close chat");
  head.append(title, close);

  const log = el("div", "scc-log");
  log.setAttribute("aria-live", "polite");

  const form = el("form", "scc-form");
  const input = el("textarea");
  input.rows = 1;
  input.maxLength = 2000;
  input.placeholder = "Type your message…";
  input.setAttribute("aria-label", "Your message");
  const send = el("button", "scc-send", "Send");
  send.type = "submit";
  form.append(input, send);

  const note = el("div", "scc-note");
  note.append("AI can make mistakes. Don't share confidential data. ");
  const pl = el("a", null, "Privacy");
  pl.href = "/privacy.html";
  note.appendChild(pl);

  panel.append(head, log, form, note);
  document.body.append(launcher, panel);

  function draw() {
    log.textContent = "";
    for (const m of state.messages) {
      const b = el("div", "scc-msg scc-" + m.role);
      renderText(b, m.content);
      log.appendChild(b);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setOpen(open) {
    state.open = open;
    panel.classList.toggle("scc-open", open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.hidden = open;
    if (open) { draw(); input.focus(); }
    save();
  }

  launcher.addEventListener("click", () => setOpen(true));
  close.addEventListener("click", () => setOpen(false));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = "";
    state.messages.push({ role: "user", content: text });
    draw();
    const typing = el("div", "scc-msg scc-assistant scc-typing", "…");
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    send.disabled = true;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: state.messages, handoffSent: state.handoffSent }),
      });
      const data = await res.json().catch(() => ({}));
      const reply = data.reply || data.error || "Sorry, something went wrong. Please use the contact form below.";
      if (data.handoffSent) state.handoffSent = true;
      state.messages.push({ role: "assistant", content: reply });
    } catch (err) {
      state.messages.push({ role: "assistant", content: "I couldn't connect just now. Please try again, or use the contact form on this page." });
    } finally {
      send.disabled = false;
      save();
      draw();
      input.focus();
    }
  });

  if (state.open) setOpen(true);
})();
