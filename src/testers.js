// Tester accounts for the QA platform, kept in data/testers.json with bcrypt hashes.
// On first start the file is created from QA_USERS in .env (those become admins);
// after that, accounts are managed in the tool (Team page).
import crypto from "crypto";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { badRequest } from "./db.js";

const FILE = path.join(config.root, "data", "testers.json");
const MIN_PASSWORD = 10;
// Compared against for unknown names, so timing doesn't reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);

let testers = [];

const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ testers }, null, 2));
};

const normal = name => String(name || "").trim().toLowerCase();
const find = name => testers.find(t => t.name === normal(name));
const now = () => new Date().toISOString();
const newPassword = () => crypto.randomBytes(12).toString("base64url");

const checkName = name => {
  if (!/^[a-z0-9._-]{2,40}$/.test(name)) throw badRequest("Usernames use 2–40 letters, digits, dots, dashes or underscores.");
};
const checkPassword = password => {
  if (String(password || "").length < MIN_PASSWORD) throw badRequest(`Passwords need at least ${MIN_PASSWORD} characters.`);
};

/** Loads the accounts, creating them from QA_USERS on first start. Returns false if there are none. */
export const initTesters = seed => {
  if (fs.existsSync(FILE)) {
    testers = JSON.parse(fs.readFileSync(FILE, "utf8")).testers || [];
  }
  // First start, or every admin removed by hand: (re)create admins from QA_USERS.
  if (!testers.some(t => t.role === "admin") && seed.size) {
    for (const [name, password] of seed) {
      if (find(name) || password.length < MIN_PASSWORD) continue;
      testers.push({ name: normal(name), hash: bcrypt.hashSync(password, 10), role: "admin", created_at: now(), created_by: ".env", password_changed_at: now() });
    }
    save();
  }
  return testers.length > 0;
};

export const hasTester = name => !!find(name);
export const roleOf = name => find(name)?.role ?? null;
/** Changes whenever the password does; sessions carry it so old sessions stop working. */
export const versionOf = name => find(name)?.password_changed_at ?? null;

export const verifyTester = async (name, password) => {
  const t = find(name);
  const ok = await bcrypt.compare(String(password ?? ""), t?.hash ?? DUMMY_HASH);
  return ok && !!t;
};

export const listTesters = () =>
  testers.map(({ name, role, created_at, created_by, password_changed_at, last_login_at }) => ({ name, role, created_at, created_by, password_changed_at, last_login_at }));

export const markLogin = name => {
  const t = find(name);
  if (t) { t.last_login_at = now(); save(); }
};

export const addTester = ({ name, role = "tester", password }, actor) => {
  const n = normal(name);
  checkName(n);
  if (find(n)) throw badRequest(`“${n}” already exists.`);
  const pw = password ? String(password) : newPassword();
  checkPassword(pw);
  testers.push({ name: n, hash: bcrypt.hashSync(pw, 10), role: role === "admin" ? "admin" : "tester", created_at: now(), created_by: actor, password_changed_at: now() });
  save();
  return { name: n, role: role === "admin" ? "admin" : "tester", password: pw };
};

export const resetTesterPassword = name => {
  const t = find(name);
  if (!t) throw badRequest("No such tester.");
  const pw = newPassword();
  t.hash = bcrypt.hashSync(pw, 10);
  t.password_changed_at = now();
  save();
  return { name: t.name, password: pw };
};

export const setTesterRole = (name, role, actor) => {
  const t = find(name);
  if (!t) throw badRequest("No such tester.");
  if (t.name === normal(actor) && role !== "admin") throw badRequest("You can't remove your own admin rights.");
  if (t.role === "admin" && role !== "admin" && testers.filter(x => x.role === "admin").length === 1) throw badRequest("There must be at least one admin.");
  t.role = role === "admin" ? "admin" : "tester";
  save();
  return { name: t.name, role: t.role };
};

export const removeTester = (name, actor) => {
  const t = find(name);
  if (!t) throw badRequest("No such tester.");
  if (t.name === normal(actor)) throw badRequest("You can't remove yourself.");
  if (t.role === "admin" && testers.filter(x => x.role === "admin").length === 1) throw badRequest("There must be at least one admin.");
  testers = testers.filter(x => x !== t);
  save();
  return { removed: t.name };
};

export const changeOwnPassword = async (name, current, next) => {
  const t = find(name);
  if (!t || !(await bcrypt.compare(String(current ?? ""), t.hash))) throw badRequest("Your current password is wrong.");
  checkPassword(next);
  t.hash = bcrypt.hashSync(String(next), 10);
  t.password_changed_at = now();
  save();
  return { ok: true };
};
