// The model behind the platform's AI features: Claude (Anthropic), OpenAI or
// Gemini (Google), chosen on the Settings page (AI_PROVIDER). JSON answers only.
// Settings are read on every call, so a change applies without a restart.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { badRequest } from "../db.js";

const env = process.env;

// In "automatic" order: the first one with a key is used.
export const PROVIDERS = {
  claude: { label: "Claude", keyVar: "ANTHROPIC_API_KEY", modelVar: "CLAUDE_MODEL", model: "claude-opus-5-5" },
  openai: { label: "OpenAI", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", model: "gpt-5.4-mini" },
  gemini: { label: "Gemini", keyVar: "GEMINI_API_KEY", modelVar: "GEMINI_MODEL", model: "gemini-2.5-flash" },
};

/** Which provider and model the AI buttons use right now. */
export const aiInfo = () => {
  const choice = env.AI_PROVIDER || "auto";
  const provider = choice === "off" ? null
    : PROVIDERS[choice] ? (env[PROVIDERS[choice].keyVar] ? choice : null)
    : Object.keys(PROVIDERS).find(p => env[PROVIDERS[p].keyVar]) || null;
  return {
    provider,
    choice,
    model: provider ? env[PROVIDERS[provider].modelVar] || PROVIDERS[provider].model : null,
    label: provider ? PROVIDERS[provider].label : null,
  };
};

export const aiEnabled = () => !!aiInfo().provider;

// Requests per tester per day, so a loop or a big scan can't run up a bill.
const usage = new Map();
const countUse = actor => {
  const limit = Number(env.AI_DAILY_LIMIT || 300);
  const key = `${actor}:${new Date().toISOString().slice(0, 10)}`;
  const n = (usage.get(key) || 0) + 1;
  if (n > limit) throw badRequest(`Daily AI limit reached (${limit} requests). It resets at midnight UTC.`);
  usage.set(key, n);
};

const parseJson = text => {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { /* try the JSON inside the text */ }
  const start = cleaned.search(/[[{]/), end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error("The answer wasn't JSON.");
};

// ---------- Claude ----------
// Server-side fallback: if a model declines, the API reruns the request on a
// suitable model in the same call. Only these models accept it.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);
let claude = null, claudeKey = null;
const claudeClient = key => {
  if (!claude || claudeKey !== key) { claude = new Anthropic({ apiKey: key }); claudeKey = key; }
  return claude;
};

const askClaude = async ({ system, text, key = env.ANTHROPIC_API_KEY, model = env.CLAUDE_MODEL || "claude-opus-5-5" }) => {
  const client = claudeClient(key);
  const request = {
    model,
    max_tokens: 16000,
    system: `${system}\n\nAnswer with the JSON only: no prose, no code fences.`,
    messages: [{ role: "user", content: text }],
  };
  let response;
  try {
    response = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(request);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw badRequest("Claude rejected the API key. Check it on the Settings page.");
    if (error instanceof Anthropic.PermissionDeniedError) throw badRequest("This Claude API key isn't allowed to use that model.");
    if (error instanceof Anthropic.NotFoundError) throw badRequest(`Claude doesn't know the model “${model}”. Pick another on the Settings page.`);
    if (error instanceof Anthropic.RateLimitError) throw badRequest("Claude's rate limit for this key was reached. Try again in a minute.");
    if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
      throw badRequest("The Anthropic account behind this key has no credit left. Add credit at console.anthropic.com → Billing.");
    }
    if (error instanceof Anthropic.BadRequestError) throw badRequest(`Claude refused the request: ${error.message}`);
    throw error; // connection problems and 5xx: the SDK already retried twice
  }
  if (response.stop_reason === "refusal") throw badRequest("Claude declined to answer this one. Try rewording the input.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (too long).");
  return response.content.filter(b => b.type === "text").map(b => b.text).join("");
};

// ---------- Gemini ----------
const askGemini = async ({ system, text, key = env.GEMINI_API_KEY, model = env.GEMINI_MODEL || "gemini-2.5-flash" }) => {
  const m = new GoogleGenerativeAI(key).getGenerativeModel({
    model,
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  });
  try {
    const result = await m.generateContent({
      systemInstruction: { role: "system", parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
    });
    return result.response.text();
  } catch (error) {
    if (/API key|permission|PERMISSION_DENIED|API_KEY_INVALID/i.test(error.message)) {
      throw badRequest("Gemini rejected the API key. Check it on the Settings page.");
    }
    // Billing and quota problems don't fix themselves on retry.
    if (/402|Payment Required|credits are depleted|billing/i.test(error.message)) {
      throw badRequest("The Gemini project behind this API key has no credit left. Top it up at https://ai.studio/projects (Billing), or switch to Claude on the Settings page.");
    }
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(error.message)) {
      throw badRequest("Gemini's usage limit for this API key was reached. Try again later, or raise the quota in Google AI Studio.");
    }
    throw error;
  }
};

// ---------- OpenAI ----------
let openai = null, openaiKey = null;
const askOpenAI = async ({ system, text, key = env.OPENAI_API_KEY, model = env.OPENAI_MODEL || "gpt-5.4-mini" }) => {
  if (!openai || openaiKey !== key) { openai = new OpenAI({ apiKey: key }); openaiKey = key; }
  let r;
  try {
    r = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${system}\n\nAnswer with a JSON object only.` },
        { role: "user", content: text },
      ],
    });
  } catch (error) {
    if (error instanceof OpenAI.AuthenticationError) throw badRequest("OpenAI rejected the API key. Check it on the Settings page.");
    if (error instanceof OpenAI.PermissionDeniedError) throw badRequest("This OpenAI key isn't allowed to use that model (check the project's model access).");
    if (error instanceof OpenAI.NotFoundError) throw badRequest(`OpenAI doesn't know the model “${model}”, or this key can't use it. Pick another on the Settings page.`);
    if (error instanceof OpenAI.RateLimitError) {
      throw badRequest(/quota|billing/i.test(error.message)
        ? "The OpenAI account behind this key has no credit left. Add credit at platform.openai.com → Billing."
        : "OpenAI's rate limit for this key was reached. Try again in a minute.");
    }
    if (error instanceof OpenAI.BadRequestError) throw badRequest(`OpenAI refused the request: ${error.message}`);
    throw error;
  }
  const choice = r.choices[0];
  if (choice?.message?.refusal) throw badRequest("OpenAI declined to answer this one. Try rewording the input.");
  if (choice?.finish_reason === "length") throw new Error("OpenAI's answer was cut off (too long).");
  return choice?.message?.content || "";
};

const ASK = { claude: askClaude, openai: askOpenAI, gemini: askGemini };

/** Ask the configured model for a JSON answer. `system` sets the rules, `input` is the data/question. */
export const askJson = async ({ actor, system, input }) => {
  const { provider } = aiInfo();
  if (!provider) throw badRequest("AI is off. An admin can turn it on with a Claude, OpenAI or Gemini key on the Settings page.");
  countUse(actor);
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 1);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parseJson(await ASK[provider]({ system, text }));
    } catch (error) {
      if (error.status === 400) throw error; // key, credit, model: retrying won't help
      lastError = error;
      await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw new Error(`The AI didn't answer properly: ${lastError?.message}`);
};

/** For the Settings page: does this provider, key and model answer? Nothing is counted against the daily limit. */
export const testAi = async ({ provider, key, model }) => {
  if (!ASK[provider]) throw badRequest("Pick Claude, OpenAI or Gemini to test.");
  if (!key) throw badRequest("Add an API key first.");
  const started = Date.now();
  const answer = parseJson(await ASK[provider]({
    system: 'You check that an API connection works. Reply with {"ok": true, "model": "<your model name>"}.',
    text: "Connection test.", key, model,
  }));
  return { ok: answer?.ok === true, ms: Date.now() - started, provider, model };
};
