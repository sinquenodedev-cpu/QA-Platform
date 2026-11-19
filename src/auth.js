// Login for the QA platform. Accounts live in data/testers.json (see testers.js);
// QA_USERS in .env ("alice:password1,bob:password2") only seeds the first admins.
// Sessions are HMAC-signed cookies.
import crypto from "crypto";
import { hasTester, markLogin, verifyTester, versionOf } from "./testers.js";

const COOKIE = "sqa_session";
const SESSION_HOURS = 12;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const createAuth = ({ secret }) => {
  const key = secret || crypto.randomBytes(32).toString("hex");
  const sign = payload => crypto.createHmac("sha256", key).update(payload).digest("base64url");

  // Slow down guessing: at most 10 failed attempts per IP per 15 minutes.
  const failures = new Map();
  const blocked = ip => {
    const f = failures.get(ip);
    if (!f || f.until < Date.now()) return false;
    return f.count >= 10;
  };
  const recordFailure = ip => {
    const f = failures.get(ip);
    if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
    else f.count++;
  };

  const check = async (username, password, ip) => {
    if (blocked(ip)) return { ok: false, error: "Too many attempts. Try again in 15 minutes." };
    const name = String(username || "").trim().toLowerCase();
    if (!(await verifyTester(name, password))) {
      recordFailure(ip);
      return { ok: false, error: "Wrong username or password." };
    }
    failures.delete(ip);
    markLogin(name);
    return { ok: true, user: name };
  };

  // `v` = the account's password version: a reset or removal ends existing sessions.
  const issue = user => {
    const payload = Buffer.from(JSON.stringify({ u: user, v: versionOf(user), exp: Date.now() + SESSION_HOURS * 3600e3 })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };

  const readCookie = (req, name) =>
    (req.headers.cookie || "")
      .split(";")
      .map(c => c.trim().split("="))
      .find(([k]) => k === name)?.[1];

  /** Logged-in username, or null. */
  const userFrom = req => {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    try {
      const { u, v, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
      return exp > Date.now() && hasTester(u) && v === versionOf(u) ? u : null;
    } catch {
      return null;
    }
  };

  // Secure cookies when reached over HTTPS (e.g. through ngrok).
  const cookieFlags = req =>
    `Path=/; HttpOnly; SameSite=Lax${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;

  const sessionCookie = (req, user) => `${COOKIE}=${issue(user)}; ${cookieFlags(req)}; Max-Age=${SESSION_HOURS * 3600}`;
  const clearCookie = req => `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`;

  /** Short-lived signed token for links that work without a session (e.g. the phone login card). */
  const signLink = (data, minutes) => {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + minutes * 60e3 })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };
  const readLink = token => {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  };

  return { check, userFrom, sessionCookie, clearCookie, signLink, readLink };
};

/** Client IP, honouring the tunnel's forwarded header. */
export const clientIp = req =>
  String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
