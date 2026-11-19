// Encrypts secrets the platform keeps on disk (personal Jira tokens, keys and
// passwords saved on the Settings page) with AES-256-GCM. The key comes from
// JIRA_TOKEN_KEY in .env, else a random key created once in data/jira.key.
// No imports from config.js: config.js uses this before it is built.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const KEY_FILE = path.join(DATA, "jira.key");

let key = null;
const encKey = () => {
  if (key) return key;
  let secret = process.env.JIRA_TOKEN_KEY;
  if (!secret) {
    if (!fs.existsSync(KEY_FILE)) {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    secret = fs.readFileSync(KEY_FILE, "utf8").trim();
  }
  key = crypto.scryptSync(secret, "efutures-qa-jira", 32);
  return key;
};

export const encrypt = text => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
};

export const decrypt = e => {
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(e.iv, "base64"));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8");
};

export const dataDir = DATA;
