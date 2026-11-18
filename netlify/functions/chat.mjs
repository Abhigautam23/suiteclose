// SuiteClose website assistant — Netlify Function at /api/chat.
//
// The browser sends the visible chat history (text only). This function runs a
// short tool-use loop with Claude and returns the assistant's reply.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY      required
//   CHAT_MODEL             optional, defaults to claude-opus-5-5
//   HANDOFF_ENDPOINT       optional, Formspree (or similar) URL that emails you hand-offs
//   BOOKING_URL            optional, e.g. a Cal.com / Calendly link for discovery calls
//   ALLOWED_ORIGINS        optional, comma-separated; defaults to the suiteclose.co.uk origins

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

const SITE = "https://suiteclose.co.uk";
const DEFAULT_ORIGINS = [SITE, "https://www.suiteclose.co.uk"];
const MAX_TURNS = 20; // messages kept from the browser history
const MAX_CHARS = 2000; // per message

const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : process.env[k]);

// ---------------------------------------------------------------------------
// Facts the assistant may state. Keep these in sync with index.html.
// ---------------------------------------------------------------------------
const SERVICES = {
  free_audit: {
    name: "Free AI Readiness Audit",
    price: "Free",
    what: "A 10-question self-assessment (about 3 minutes) that scores your NetSuite data layer across 5 dimensions.",
    url: `${SITE}/audit/`,
  },
  tier1: {
    name: "In-depth NetSuite data audit",
    price: "£995 one-time",
    what: "Hands-on review of your NetSuite account: chart of accounts mapping, where reports disagree, and a written fix plan.",
  },
  tier2: {
    name: "Automated reporting layer",
    price: "£4,500 project",
    what: "Replaces Excel reporting with a live, model-driven P&L, balance sheet and trial balance refreshed from NetSuite.",
  },
  tier3: {
    name: "Ongoing data engineering",
    price: "£1,200 / month",
    what: "Retainer: model maintenance, new account mapping, custom schedules, and a data engineer on call.",
  },
};

const CONTENT = {
  ai_wrong_answers: ["Why NetSuite AI gives wrong answers", "/why-netsuite-ai-gives-wrong-answers.html"],
  pl_vs_ai: ["Why the NetSuite P&L doesn't match AI output", "/why-netsuite-pl-not-match-ai-output.html"],
  revenue_mismatch: ["Why revenue differs between reports", "/why-revenue-different-between-reports.html"],
  inconsistent_metrics: ["How to fix inconsistent financial metrics", "/how-to-fix-inconsistent-financial-metrics-netsuite.html"],
  tb_vs_gl: ["Why the trial balance doesn't match the GL", "/why-trial-balance-does-not-match-gl-netsuite.html"],
  hidden_issues: ["Common NetSuite data issues CFOs miss", "/common-netsuite-data-issues-cfos-miss.html"],
  demo: ["Interactive demo dashboard", "/#demo-section"],
  audit: ["Free AI Readiness Audit", "/audit/"],
};

const SYSTEM = `You are the website assistant for SuiteClose (suiteclose.co.uk), a UK NetSuite data engineering service run by Abhisekh Kumar. Visitors are usually CFOs, finance directors or financial controllers at UK SMEs that run NetSuite.

Your job:
1. Welcome the visitor and find out what they are trying to solve: their NetSuite setup, how long month-end close takes, whether they rely on Excel exports, and whether reports or AI tools give inconsistent numbers. Ask one short question at a time.
2. Point them to the most relevant page with recommend_content, and suggest the free AI Readiness Audit when they are still exploring.
3. Answer questions about services and prices using get_services_and_pricing. Only quote prices that tool returns.
4. When they want to talk to a person, book a call, get a quote, or have a question you cannot answer from the tools, use request_handoff. Before calling it, ask for their name and email and get a clear yes to passing their details to Abhisekh. Include a short summary of their situation.

Rules:
- You are an AI assistant; say so if asked. Abhisekh follows up personally on every hand-off, usually within one business day.
- Never promise outcomes, timelines, discounts or custom prices. Never claim client names, case studies or statistics. If unsure, hand off.
- Do not ask for or accept NetSuite credentials, financial data or other confidential files. Ask them to share those only on a call.
- Keep replies short (2–4 sentences), plain, and in British English. No markdown headings.
- Stay on SuiteClose, NetSuite finance data and reporting. Politely decline unrelated requests.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function makeTools(handoffState) {
  const getServices = betaTool({
    name: "get_services_and_pricing",
    description: "Returns SuiteClose's services, what each includes, and fixed prices.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const booking = env("BOOKING_URL");
      return JSON.stringify({ services: SERVICES, booking_url: booking || null });
    },
  });

  const recommend = betaTool({
    name: "recommend_content",
    description:
      "Returns the title and link of the SuiteClose page that best matches the visitor's problem, so you can share it.",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", enum: Object.keys(CONTENT) } },
      required: ["topic"],
      additionalProperties: false,
    },
    run: async ({ topic }) => {
      const hit = CONTENT[topic];
      if (!hit) return JSON.stringify({ error: "unknown topic", topics: Object.keys(CONTENT) });
      return JSON.stringify({ title: hit[0], url: SITE + hit[1] });
    },
  });

  const handoff = betaTool({
    name: "request_handoff",
    description:
      "Sends the visitor's details and a summary to Abhisekh so he can follow up personally. Only call after the visitor has given their name and email and agreed to be contacted.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        company: { type: "string" },
        summary: { type: "string", description: "Their situation and what they want, in 2–5 sentences." },
        likely_service: { type: "string", enum: ["free_audit", "tier1", "tier2", "tier3", "unsure"] },
        preferred_times: { type: "string", description: "When they'd like a call, if mentioned." },
        consent: { type: "boolean", description: "True only if the visitor explicitly agreed to be contacted." },
      },
      required: ["name", "email", "summary", "consent"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (!input.consent) return "Not sent: the visitor has not agreed to be contacted. Ask them first.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email || "")) return "Not sent: that email address looks invalid. Ask them to check it.";
      if (handoffState.sent) return "Already sent in this conversation.";
      const endpoint = env("HANDOFF_ENDPOINT");
      if (!endpoint) return "Hand-off is not configured. Ask the visitor to use the contact form at " + SITE + "/#contact-section.";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          _subject: `SuiteClose chat hand-off: ${input.name}${input.company ? " (" + input.company + ")" : ""}`,
          source: "Website assistant",
          ...input,
        }),
      });
      if (!res.ok) return "Sending failed. Ask the visitor to use the contact form at " + SITE + "/#contact-section.";
      handoffState.sent = true;
      const booking = env("BOOKING_URL");
      return "Sent. Abhisekh will follow up by email, usually within one business day." +
        (booking ? ` They can also pick a time directly: ${booking}` : "");
    },
  });

  return [getServices, recommend, handoff];
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });

export default async (req) => {
  const allowed = (env("ALLOWED_ORIGINS") || DEFAULT_ORIGINS.join(",")).split(",").map((s) => s.trim());
  const origin = req.headers.get("origin");
  let sameHost = false;
  try {
    sameHost = Boolean(origin) && new URL(origin).host === (req.headers.get("host") || new URL(req.url).host);
  } catch {}
  // Allow the production domains and whatever host is serving this function
  // (covers Netlify deploy previews, which send an Origin even for same-site requests).
  const okOrigin = origin && (allowed.includes(origin) || sameHost) ? origin : null;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: okOrigin
        ? { "Access-Control-Allow-Origin": okOrigin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" }
        : {},
    });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Requests from other websites are refused.
  if (origin && !okOrigin) return json({ error: "Forbidden" }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, okOrigin);
  }
  const messages = cleanHistory(body?.messages);
  if (!messages) return json({ error: "Send a messages array ending with a user message." }, 400, okOrigin);

  const handoffState = { sent: Boolean(body?.handoffSent) };
  const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  try {
    const final = await client.beta.messages.toolRunner({
      model: env("CHAT_MODEL") || "claude-opus-5-5",
      max_tokens: 2000, // replies are deliberately short
      output_config: { effort: "low" }, // conversational routing, not deep reasoning
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if the model declines, the API retries on a fallback model
      cache_control: { type: "ephemeral" }, // system prompt + tools are identical every request
      system: SYSTEM,
      tools: makeTools(handoffState),
      messages,
      max_iterations: 6,
    });

    if (final.stop_reason === "refusal") {
      return json({ reply: "Sorry, I can't help with that here. You can reach Abhisekh through the contact form on this page.", handoffSent: handoffState.sent }, 200, okOrigin);
    }
    const reply = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return json({ reply: reply || "Sorry, I didn't catch that. Could you rephrase?", handoffSent: handoffState.sent }, 200, okOrigin);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "The assistant is busy. Please try again in a minute." }, 429, okOrigin);
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return json({ error: "The assistant is unavailable right now. Please use the contact form." }, 502, okOrigin);
    }
    console.error("chat function error", err);
    return json({ error: "Something went wrong. Please use the contact form." }, 500, okOrigin);
  }
};

export const config = { path: "/api/chat" };
