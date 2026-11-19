// Personal Jira connections: each tester can sign the platform in to Jira with
// their own Atlassian email and API token, so tickets, comments and edits show
// up under their name. Tokens are stored encrypted (AES-256-GCM) in
// data/jira-users.json and are never sent back to the page.
import { AsyncLocalStorage } from "async_hooks";
import { config } from "./config.js";
import { dataPath, readJson, writeJson } from "./store.js";
import { decrypt, encrypt } from "./secretbox.js";

const FILE = dataPath("jira-users.json");

// Who the current request (or background job started by it) is for.
export const requestContext = new AsyncLocalStorage();
export const currentActor = () => requestContext.getStore()?.actor || null;

const users = () => readJson(FILE, {});
const name = u => String(u || "").toLowerCase();

/** The Jira login to use for a tester: their own if connected, else the shared one from .env. */
export const credentialsFor = actor => {
  const own = actor && users()[name(actor)];
  if (own) {
    try { return { email: own.email, token: decrypt(own.token), personal: true, account: own.account }; }
    catch { /* key changed: treat as not connected */ }
  }
  if (config.jira.email && config.jira.token) return { email: config.jira.email, token: config.jira.token, personal: false };
  return null;
};

export const connectionInfo = actor => {
  const own = users()[name(actor)];
  return {
    personal: !!own, email: own?.email || null, account: own?.account || null, connected_at: own?.connected_at || null,
    shared: !!(config.jira.email && config.jira.token), base_url: config.jira.baseUrl,
  };
};

/** Checks the email and token with Jira, then saves them for this tester. */
export const connect = async (actor, { email, token }) => {
  email = String(email || "").trim(); token = String(token || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("Enter the email you sign in to Jira with."), { status: 400 });
  if (token.length < 20) throw Object.assign(new Error("Paste the whole API token from your Atlassian account."), { status: 400 });
  const res = await fetch(`${config.jira.baseUrl}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Jira didn't accept that email and token. Check both and try again."), { status: 400 });
  if (!res.ok) throw Object.assign(new Error(`Jira answered ${res.status}. Try again in a moment.`), { status: 400 });
  const me = await res.json();
  const all = users();
  all[name(actor)] = { email, token: encrypt(token), account: me.displayName || email, account_id: me.accountId, connected_at: new Date().toISOString() };
  writeJson(FILE, all);
  return connectionInfo(actor);
};

export const disconnect = actor => {
  const all = users();
  delete all[name(actor)];
  writeJson(FILE, all);
  return connectionInfo(actor);
};
