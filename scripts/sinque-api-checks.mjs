// Adds an API check for every endpoint of the Sinque backend to the Sinque project.
// Reads the serverless definitions from the backend checkout (SINQUE_BACKEND_PATH,
// default ../sinque-backend). Safe to run again: checks already added are skipped.
//
//   npm run sinque:api-checks
//
// - Read-only GETs are switched on, signed in as the platform's own test accounts.
// - Anything that changes data (POST, PUT, PATCH, DELETE) is added switched OFF:
//   fill in a body, then switch it on to test it on DEV.
// - Every endpoint that needs a login also gets a "rejects without login" check.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const { getProject } = await import("../src/projects.js");
const { importChecks, removeChecks } = await import("../src/apichecks.js");
const { pool } = await import("../src/db.js");

const backend = path.resolve(process.env.SINQUE_BACKEND_PATH || "../sinque-backend");
const apps = path.join(backend, "apps");
if (!fs.existsSync(apps)) { console.error(`Sinque backend not found at ${backend}. Set SINQUE_BACKEND_PATH.`); process.exit(1); }

// ---------- read the endpoints from serverless.yml / src/functions/*.yml ----------
const endpoints = [];
for (const dir of fs.readdirSync(apps).sort()) {
  const sls = path.join(apps, dir, "serverless.yml");
  if (!fs.existsSync(sls)) continue;
  // The backend's files use Windows line endings.
  const read = f => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const slsText = read(sls);
  const base = slsText.match(/basePath:\s*['"]?([\w-]*)/)?.[1] || "";
  const fnDir = path.join(apps, dir, "src", "functions");
  const files = fs.existsSync(fnDir) ? fs.readdirSync(fnDir).filter(f => f.endsWith(".yml")).map(f => path.join(fnDir, f)) : [sls];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/^  ([\w-]+):\n((?:    .*\n|\s*\n)+)/gm)) {
      const [, name, block] = m;
      for (const ev of block.matchAll(/- http(?:Api)?:\s*\n((?:          .*\n)+)/g)) {
        // Commented-out lines don't count, but a commented-out authorizer is worth knowing about.
        const e = ev[1].split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
        const loginOff = /^\s*#\s*authorizer/m.test(ev[1]);
        const p = e.match(/path:\s*(\S+)/)?.[1], method = e.match(/method:\s*(\S+)/)?.[1];
        if (!p || !method) continue;
        endpoints.push({
          service: dir.replace(/-service$/, ""), name, method: method.toUpperCase(),
          path: `${base ? `/${base}` : ""}/${p.replace(/['"]/g, "").replace(/^\//, "")}`,
          auth: /authorizer:/.test(e), partner: /partnerAuthorizer/.test(e), admin: /adminAuthorizer/.test(e), loginOff,
          file: path.relative(apps, f).replace(/\\/g, "/"),
        });
      }
    }
  }
}

// ---------- turn them into checks ----------
const title = n => n.replace(/-/g, " ").replace(/\b(\w)/, c => c.toUpperCase());
// The app's own screens sign in as the app user; admin and dashboard screens as the dashboard login.
// The admin authorizer takes a dashboard login; the normal one takes an app login.
const isAdmin = e => e.admin;
// {id} parts the platform can fill with its own test accounts; the rest stay for the tester.
const ID_FOR = [
  [/^\/admin\/professional\/\{id\}/, "{{sinque.professional_id}}"],
  [/^\/admin\/reports\/overview\/(summary|user|userweightdata)\/\{id\}/, "{{sinque.user_id}}"],
  [/^\/group\/admin\/group\/\{id\}/, "{{sinque.group_id}}"],
  [/^\/group\/subgroups\/\{id\}/, "{{sinque.group_id}}"],
  [/^\/group\/admin\/subgroup\/\{id\}/, "{{sinque.subgroup_id}}"],
  [/^\/user\/admin\/user\/(measurements\/)?\{id\}/, "{{sinque.user_id}}"],
];
const fillIds = p => {
  let out = p.replace("{sinque_id}", "{{sinque.sinque_id}}").replace("{user_id}", "{{sinque.user_id}}");
  const hit = ID_FOR.find(([re]) => re.test(out));
  return hit ? out.replace("{id}", hit[1]) : out;
};
// Reads that are heavy, cost money or leave the API.
const SKIP_GET = {
  "export-all-sinque-users": "Exports every user: run it on purpose, not in Run all",
  "generate-triage-summary": "Generates an AI triage summary each time it runs",
  "redirect-to-app-store": "Redirects to the app store",
};

const checks = [];
for (const e of endpoints) {
  const key = `sinque:${e.method} ${e.path}`;
  const filled = fillIds(e.path);
  const open = /\{[\w]+\}/.test(filled);
  const headers = e.partner ? { Authorization: "Bearer {{secret.PARTNER_TOKEN}}" }
    : e.auth ? { Authorization: `Bearer {{login.${isAdmin(e) ? "dashboard" : "app"}}}` } : {};
  const read = e.method === "GET";
  const login = e.path === "/auth/login";
  let enabled = read && !open && !e.partner && !SKIP_GET[e.name];
  const notes = [`${e.service} service · ${e.file} · ${e.name}`];
  if (!read && !login) notes.push("Changes data: fill in a body and switch it on to test it on DEV.");
  if (open) notes.push(`Fill in ${filled.match(/\{[\w]+\}/)[0]} to switch it on.`);
  if (e.partner) notes.push("Needs a partner token: add QA_SECRET_PARTNER_TOKEN to .env, then switch it on.");
  if (e.loginOff) notes.push("Its login check is commented out in the backend, so it answers without a login.");
  if (SKIP_GET[e.name]) notes.push(SKIP_GET[e.name] + ".");
  let body = "", assertions = [{ type: "status", op: "<", value: "500" }, { type: "time", op: "<", value: "8000" }];
  if (/healthcheck|apple-app-site-association/.test(e.path)) assertions = [{ type: "status", op: "=", value: "200" }, { type: "time", op: "<", value: "5000" }];
  else if (read && e.auth && !e.partner) assertions = [{ type: "status", op: "<", value: "400" }, { type: "time", op: "<", value: "8000" }];
  if (login) {
    // Signing in changes nothing, so it runs: the app user with the test password.
    enabled = true;
    body = JSON.stringify({ email: "{{sinque.app_email}}", password: "{{sinque.test_password}}" });
    assertions = [{ type: "status", op: "=", value: "200" }, { type: "json", path: "data.accessToken", op: "exists", value: "" }, { type: "time", op: "<", value: "5000" }];
    notes.push("Signs in as the platform's API test user.");
  } else if (!read) body = "{}";
  checks.push({
    key, group: e.service, name: `${title(e.name)}`, method: e.method, path: filled, headers, body, assertions, enabled,
    tags: [e.service, read ? "read" : "writes", ...(e.auth ? ["login"] : []), ...(e.loginOff ? ["no-login"] : [])], description: notes.join(" "),
  });
  if (e.auth) {
    // Without a token the gateway answers 401/403 before any code runs, so this is safe for every method.
    checks.push({
      key: `sinque:noauth ${e.method} ${e.path}`, group: e.service, name: `${title(e.name)}: rejects without login`, method: e.method,
      path: e.path.replace(/\{[\w]+\}/g, "0"), headers: {}, body: "",
      assertions: [{ type: "status", op: ">=", value: "401" }, { type: "status", op: "<=", value: "403" }],
      enabled: true, tags: [e.service, "security"],
      description: `${e.service} service · ${e.name}. Calls the endpoint with no login; it must refuse (401 or 403).`,
    });
  }
}

const project = getProject("SINQUE", "admin", "admin");
// --replace swaps the generated checks for fresh ones (your own checks stay).
if (process.argv.includes("--replace")) console.log(`Removed ${removeChecks(project, c => String(c.key || "").startsWith("sinque:")).removed} generated checks.`);
const r = importChecks(project, checks, "sinque-api-checks script");
const on = checks.filter(c => c.enabled).length;
console.log(`${endpoints.length} endpoints → ${checks.length} checks (${on} switched on, ${checks.length - on} off). Added ${r.added}, project now has ${r.total}.`);
await pool.end();
process.exit(0);
