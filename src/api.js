// Calls to the deployed DEV API, so QA sees exactly what the apps get.
import { config } from "./config.js";

const call = async (method, path, body, token) => {
  if (!config.apiBaseUrl) throw new Error("API_BASE_URL is not set in .env.");
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "Accept-Language": "en", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, body: json };
};

/** The weekly body-composition report, as the admin-service returns it. */
export const fetchReport = userId => call("GET", `/admin/reports/overview/userweightdata/${encodeURIComponent(userId)}`);

/** Tries the real login. `admin` = dashboard login (professionals/admins), otherwise mobile app login. */
export const tryLogin = (email, password, admin = false) => call("POST", "/auth/login", { email, password, ...(admin ? { admin: true } : {}) });

/** Logs in and returns the access token, or throws with the API's reason. */
export const loginToken = async (email, password, admin = false) => {
  const res = await tryLogin(email, password, admin);
  const token = res.body?.data?.accessToken;
  if (!res.ok || !token) throw new Error(`Login as ${email} failed (${res.status}): ${res.body?.message || "no token"}`);
  return token;
};

/** The app's progress screen data; includes the public report link the app shows. */
export const fetchProgress = token => call("GET", "/measurement/progress?page=0&size=1", null, token);

/** One page of the dashboard's Group/Subgroup Overview, as a dashboard user sees it. */
export const fetchOverview = (token, { name, groupIds = [], subgroupIds = [], size = 50 }) => {
  const q = new URLSearchParams({ page: "1", size: String(size) });
  if (name) q.set("name", name);
  if (groupIds.length) q.set("groupIds", groupIds.join(","));
  if (subgroupIds.length) q.set("subgroupIds", subgroupIds.join(","));
  return call("GET", `/admin/reports/overview?${q}`, null, token);
};
