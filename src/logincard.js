// QR code for a test user's app login. On the shared (ngrok) address the QR opens
// a small phone page with the email and password (valid 30 minutes). On localhost
// a phone can't reach the tool, so the QR holds the login as plain text instead.
import QRCode from "qrcode";
import { config, isTestEmail } from "./config.js";
import { badRequest, query } from "./db.js";

const CARD_MINUTES = 30;

const testUser = async id => {
  const [u] = await query("SELECT id, sinque_id, firstname, lastname, email FROM users WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!u) throw badRequest("User not found.");
  if (!isTestEmail(u.email)) throw badRequest("Login QR codes are only for test users.");
  return u;
};

const publicBase = req => {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host);
  return { local, base: `${proto}://${host}` };
};

export const loginCard = async (req, userId, auth) => {
  const u = await testUser(userId);
  const { local, base } = publicBase(req);
  const expires = new Date(Date.now() + CARD_MINUTES * 60e3);
  const data = local
    ? `Sinque test login\nEmail: ${u.email}\nPassword: ${config.testPassword}`
    : `${base}/card/${auth.signLink({ k: "card", id: u.id }, CARD_MINUTES)}`;
  return {
    mode: local ? "text" : "link",
    url: local ? null : data,
    expires_at: local ? null : expires.toISOString(),
    svg: await QRCode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0f1d24", light: "#ffffff" } }),
  };
};

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The phone page behind the QR link. No QA login needed; the signed link is the key. */
export const cardPage = async (token, auth) => {
  const data = auth.readLink(token);
  if (!data || data.k !== "card") return { status: 410, html: page("Link expired", `<p>This login link has expired or is invalid. Make a new QR code in the QA platform.</p>`) };
  let u;
  try { u = await testUser(data.id); } catch { return { status: 404, html: page("Not available", "<p>This test user no longer exists.</p>") }; }
  const mins = Math.max(1, Math.round((data.exp - Date.now()) / 60e3));
  return {
    status: 200,
    html: page(`${u.firstname} ${u.lastname}`, `
      <p class="muted">Test user #${esc(u.sinque_id)} · Sinque app login</p>
      <div class="field"><label>Email</label><div class="val"><code id="e">${esc(u.email)}</code><button onclick="cp('e',this)">Copy</button></div></div>
      <div class="field"><label>Password</label><div class="val"><code id="p">${esc(config.testPassword)}</code><button onclick="cp('p',this)">Copy</button></div></div>
      <p class="muted small">Open the Sinque app, choose sign in, and paste these. This page stops working in ${mins} minutes.</p>`),
  };
};

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Sinque test login</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#f4f6f8;color:#0f1d24;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:#fff;border:1px solid #e3e8ec;border-radius:18px;padding:24px;box-shadow:0 12px 32px -16px rgba(16,24,40,.3)}
.logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#22b3cf,#34d399);color:#062027;font-weight:800;font-size:19px;margin-bottom:14px}
h1{font-size:21px;margin:0 0 4px}.muted{color:#6b7a83;margin:0 0 16px}.small{font-size:13.5px;margin-top:18px}
.field{margin-bottom:12px}label{display:block;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6b7a83;margin-bottom:6px}
.val{display:flex;gap:8px;align-items:center}code{flex:1;min-width:0;overflow-wrap:anywhere;font:15px ui-monospace,Consolas,monospace;background:#f4f6f8;border:1px solid #e3e8ec;border-radius:10px;padding:10px 12px}
button{font:600 14px system-ui,sans-serif;border:0;border-radius:10px;padding:11px 14px;background:#0e7490;color:#fff}
@media (prefers-color-scheme:dark){body{background:#0b1114;color:#e8eef1}main{background:#121a1e;border-color:#24323a}code{background:#0b1114;border-color:#24323a}.muted,label{color:#8a9aa2}}
</style></head><body><main><div class="logo">S</div><h1>${esc(title)}</h1>${body}</main>
<script>function cp(id,b){navigator.clipboard.writeText(document.getElementById(id).textContent).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)})}</script></body></html>`;
