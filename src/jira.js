// Jira Cloud: create tickets from bug reports and show the status of tickets
// linked to a user. Tickets are linked by label (sinque-user-<Sinque ID>), so
// tickets labelled by hand in Jira show up too.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config, isTestEmail } from "./config.js";
import { badRequest, query } from "./db.js";
import { credentialsFor, currentActor } from "./jirauser.js";

const jira = () => config.jira;

// Signed in as the tester's own Jira account when they've connected one, else the shared .env account.
export const jiraEnabled = () => !!credentialsFor(currentActor());

export const userLabel = sinqueId => `sinque-user-${sinqueId}`;

const call = async (method, path, { body, form, headers = {} } = {}) => {
  const creds = credentialsFor(currentActor());
  if (!creds) throw badRequest("Jira isn't connected. Connect your Jira account (click your name in the sidebar), or ask an admin to set a shared account.");
  const { baseUrl } = jira();
  const { email, token } = creds;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const reason = json?.errorMessages?.join(" ") || Object.values(json?.errors || {}).join(" ") || json?.raw || res.statusText;
    if (res.status === 401) throw badRequest(creds.personal
      ? "Jira didn't accept your token any more. Reconnect your Jira account (click your name in the sidebar)."
      : "Jira rejected the shared login. Check JIRA_EMAIL and JIRA_API_TOKEN in .env.");
    if (res.status === 403) throw badRequest(`Jira says this account isn't allowed to do that: ${reason}`);
    throw badRequest(`Jira answered ${res.status}: ${reason}`);
  }
  return json;
};

/** Who the tool signs in to Jira as, and the project's issue types. */
export const jiraInfo = async (projectKey = jira().project) => {
  if (!jiraEnabled()) return { enabled: false, base_url: jira()?.baseUrl, project: projectKey };
  const [me, project] = await Promise.all([
    call("GET", "/rest/api/3/myself"),
    call("GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}`),
  ]);
  return {
    enabled: true,
    base_url: jira().baseUrl,
    project: project.key,
    project_name: project.name,
    account: me.displayName,
    // Sub-tasks and epics need a parent or extra fields, so they're left out.
    issue_types: (project.issueTypes || []).filter(t => !t.subtask && !/^(sub[\s-]?task|epic)$/i.test(t.name.trim())).map(t => t.name),
    default_issue_type: jira().issueType,
  };
};

// ---------- Markdown (as the tool writes it) → Jira wiki markup ----------
const inline = s => s
  .replace(/\*\*(.+?)\*\*/g, "*$1*")
  .replace(/`([^`]+)`/g, "{{$1}}")
  .replace(/(^|\s)_(.+?)_(\s|$)/g, "$1_$2_$3")
  .replace(/✅/g, "(/)").replace(/❌/g, "(x)");

export const markdownToWiki = md => {
  const out = [];
  let tableRow = 0;
  for (const line of String(md).split("\n")) {
    if (/^\|/.test(line)) {
      const cells = line.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, "/")) || " ");
      if (cells.every(c => /^-+$/.test(c))) continue;
      out.push(tableRow === 0 ? `||${cells.join("||")}||` : `|${cells.join("|")}|`);
      tableRow++;
      continue;
    }
    tableRow = 0;
    if (/^# /.test(line)) out.push(`h2. ${inline(line.slice(2))}`);
    else if (/^## /.test(line)) out.push(`h3. ${inline(line.slice(3))}`);
    else if (/^- /.test(line)) out.push(`* ${inline(line.slice(2))}`);
    else out.push(inline(line));
  }
  return out.join("\n");
};

/**
 * Creates a ticket in the configured project with the report as description and
 * the Markdown attached. Labels link it to the user.
 */
export const createTicket = async ({ summary, markdown, issueType, sinqueId, fileName, actor, jiraProject = jira().project, labels = [] }) => {
  if (!String(summary || "").trim()) throw badRequest("Give the ticket a title.");
  const description = `${markdownToWiki(markdown)}\n\n----\n_Created from the eFutures QA platform by ${actor}._`;
  const issue = await call("POST", "/rest/api/2/issue", {
    body: {
      fields: {
        project: { key: jiraProject },
        issuetype: { name: issueType || jira().issueType },
        summary: String(summary).trim().slice(0, 250),
        description,
        labels: [...new Set(["qa-platform", ...(sinqueId ? ["sinque-qa", userLabel(sinqueId)] : []), ...labels.filter(l => /^[\w.-]+$/.test(l))])],
      },
    },
  });
  // Attach the full report too; a failed attachment doesn't undo the ticket.
  let attached = false;
  try {
    const form = new FormData();
    form.append("file", new Blob([markdown], { type: "text/markdown" }), `${fileName || "sinque-report"}.md`);
    await call("POST", `/rest/api/3/issue/${issue.key}/attachments`, { form, headers: { "X-Atlassian-Token": "no-check" } });
    attached = true;
  } catch (error) {
    console.error(`Jira attachment for ${issue.key} failed:`, error.message);
  }
  return { key: issue.key, url: `${jira().baseUrl}/browse/${issue.key}`, attached };
};

const LIST_FIELDS = ["summary", "status", "assignee", "updated", "created", "labels", "issuetype", "priority", "reporter"];

const shape = i => ({
  key: i.key,
  url: `${jira().baseUrl}/browse/${i.key}`,
  summary: i.fields?.summary,
  status: i.fields?.status?.name,
  status_category: i.fields?.status?.statusCategory?.key, // new | indeterminate | done
  assignee: i.fields?.assignee?.displayName ?? null,
  reporter: i.fields?.reporter?.displayName ?? null,
  type: i.fields?.issuetype?.name ?? null,
  type_icon: i.fields?.issuetype?.iconUrl ?? null,
  priority: i.fields?.priority?.name ?? null,
  created: i.fields?.created,
  updated: i.fields?.updated,
  labels: i.fields?.labels || [],
  from_qa_tool: (i.fields?.labels || []).some(l => l === "qa-platform" || l === "sinque-qa"),
  sinque_ids: (i.fields?.labels || []).filter(l => l.startsWith("sinque-user-")).map(l => Number(l.slice(12))).filter(Boolean),
});

const STATUS_JQL = { todo: 'statusCategory = "To Do"', progress: 'statusCategory = "In Progress"', done: "statusCategory = Done", open: "statusCategory != Done" };
const jqlText = s => String(s).replace(/["\\]/g, " ").trim();

/**
 * Tickets in the project for the Jira page. scope: qa (made by the tool), bugs, all.
 * status: todo | progress | done | open. q: text or a ticket key.
 */
export const listTickets = async ({ scope = "qa", status = "", q = "", limit = 100, jiraProject = jira().project } = {}) => {
  if (!/^[A-Z][A-Z0-9]*$/.test(jiraProject)) throw badRequest("This project has no Jira project key yet. An admin can add one under Projects.");
  const where = [`project = "${jiraProject}"`];
  if (scope === "qa") where.push('labels in ("qa-platform", "sinque-qa")');
  if (scope === "bugs") where.push("issuetype = Bug");
  if (STATUS_JQL[status]) where.push(STATUS_JQL[status]);
  const text = jqlText(q);
  if (text) where.push(/^[A-Z]+-\d+$/i.test(text) ? `key = "${text.toUpperCase()}"` : `text ~ "${text}*"`);
  const issues = [];
  let nextPageToken;
  do {
    const res = await call("POST", "/rest/api/3/search/jql", {
      body: { jql: `${where.join(" AND ")} ORDER BY updated DESC`, fields: LIST_FIELDS, maxResults: Math.min(100, limit - issues.length), ...(nextPageToken ? { nextPageToken } : {}) },
    });
    issues.push(...(res.issues || []).map(i => {
      const t = shape(i);
      const saved = readTestCases(t.key)?.test_cases || [];
      return { ...t, test_cases: saved.length, passed: saved.filter(c => c.result?.pass === true).length, failed: saved.filter(c => c.result?.pass === false).length };
    }));
    nextPageToken = res.nextPageToken;
  } while (nextPageToken && issues.length < limit);
  return { tickets: issues, base_url: jira().baseUrl, project: jiraProject };
};

/**
 * Tickets for the coverage page: the open sprint(s) of the project, or, when the
 * project has no open sprint, its open tickets. Sub-tasks and epics are left out.
 */
export const sprintTickets = async jiraProject => {
  if (!/^[A-Z][A-Z0-9]*$/.test(jiraProject || "")) throw badRequest("This project has no Jira project key yet. An admin can add one under Settings → the project.");
  const fields = await call("GET", "/rest/api/2/field").catch(() => []);
  const sprintField = fields.find(f => f.name === "Sprint" && /gh-sprint/.test(f.schema?.custom || ""))?.id;
  const base = `project = "${jiraProject}" AND issuetype not in subTaskIssueTypes() AND issuetype != Epic`;
  const fetchAll = async jql => {
    const out = [];
    let nextPageToken;
    do {
      const res = await call("POST", "/rest/api/3/search/jql", {
        body: { jql, fields: [...LIST_FIELDS, ...(sprintField ? [sprintField] : [])], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
      });
      out.push(...(res.issues || []));
      nextPageToken = res.nextPageToken;
    } while (nextPageToken && out.length < 300);
    return out;
  };
  let mode = "sprint", issues = [];
  try { issues = await fetchAll(`${base} AND sprint in openSprints() ORDER BY rank`); }
  catch { issues = []; } // no Jira Software sprints on this project
  if (!issues.length) { mode = "open"; issues = await fetchAll(`${base} AND statusCategory != Done ORDER BY updated DESC`); }
  const sprints = new Set();
  const tickets = issues.map(i => {
    const sp = sprintField ? [].concat(i.fields?.[sprintField] || []).filter(x => x?.state === "active").map(x => x.name) : [];
    sp.forEach(n => sprints.add(n));
    return { ...shape(i), sprint: sp[0] || null };
  });
  return { mode, sprints: [...sprints], tickets, base_url: jira().baseUrl, project: jiraProject };
};

/** Sinque users for these Sinque IDs (deleted users left out). */
export const usersForSinqueIds = async sinqueIds => {
  const ids = [...new Set(sinqueIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await query(
    `SELECT id, sinque_id, firstname, lastname, email FROM users WHERE sinque_id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL`, ids);
  return rows.map(u => ({ id: u.id, sinque_id: u.sinque_id, firstname: u.firstname, lastname: u.lastname, is_test_user: isTestEmail(u.email) }));
};

/** One ticket with description (Jira wiki markup), comments and linked users. */
export const getTicket = async key => {
  if (!/^[A-Z][A-Z0-9]*-\d+$/i.test(key)) throw badRequest("That isn't a Jira ticket key.");
  const i = await call("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${[...LIST_FIELDS, "description", "comment", "attachment"].join(",")}`);
  const t = shape(i);
  return {
    ...t,
    description: i.fields?.description || "",
    comments: (i.fields?.comment?.comments || []).slice(-8).map(c => ({ author: c.author?.displayName, created: c.created, body: c.body || "" })),
    attachments: (i.fields?.attachment || []).map(a => ({ name: a.filename, size: a.size })),
    users: await usersForSinqueIds(t.sinque_ids),
    saved_test_cases: readTestCases(t.key),
  };
};

/** Adds a comment (Jira wiki markup). */
export const addComment = async (key, wiki) => {
  const c = await call("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: { body: wiki } });
  return { id: c.id, url: `${jira().baseUrl}/browse/${key}?focusedCommentId=${c.id}` };
};

/** Changes a ticket's title and/or description (Jira wiki markup). */
export const updateTicket = async (key, { summary, description }) => {
  const fields = {};
  if (summary !== undefined) {
    const t = String(summary).trim();
    if (!t) throw badRequest("The ticket needs a title.");
    fields.summary = t.slice(0, 250);
  }
  if (description !== undefined) fields.description = String(description);
  if (!Object.keys(fields).length) throw badRequest("Nothing to change.");
  await call("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { body: { fields } });
  return { key, changed: Object.keys(fields) };
};

/** Links Sinque users to a ticket by adding their labels. */
export const linkUsers = async (key, sinqueIds) => {
  const labels = [...new Set(sinqueIds.filter(Boolean))].map(userLabel);
  if (!labels.length) return { added: [] };
  await call("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { body: { update: { labels: labels.map(add => ({ add })) } } });
  return { added: labels };
};

// Generated test cases are kept per ticket in data/testcases, so they're there next time.
const casesFile = key => path.join(config.root, "data", "testcases", `${key.toUpperCase()}.json`);
/** What the Jira comment shows. Changes whenever a test case, its result or the details change. */
const fingerprint = d => crypto.createHash("sha1").update(JSON.stringify([
  d.summary, d.likely_cause, d.acceptance, d.questions,
  d.test_cases.map(t => [t.id, t.title, t.kind, t.priority, t.preconditions, t.steps, t.expected, t.result ? t.result.pass : null]),
])).digest("hex");

/** Is this ticket's test case list on Jira, and is it up to date? Shown on the ticket page. */
const jiraState = d => {
  const c = d.jira_comment;
  return c
    ? { posted: true, where: c.where || "comment", field: c.field || null, posted_at: c.posted_at, posted_by: c.posted_by, url: c.url, up_to_date: c.fingerprint === fingerprint(d) }
    : { posted: false };
};

export const readTestCases = key => {
  try {
    const d = JSON.parse(fs.readFileSync(casesFile(key), "utf8"));
    d.jira_state = jiraState(d);
    return d;
  } catch { return null; }
};
export const saveTestCases = (key, data) => {
  const { jira_state, ...stored } = data;
  fs.mkdirSync(path.dirname(casesFile(key)), { recursive: true });
  fs.writeFileSync(casesFile(key), JSON.stringify(stored, null, 1));
  data.jira_state = jiraState(stored);
  return data;
};

const isOurComment = body => /^h3\. Test cases \(\d+\)/.test(body || "") && /(eFutures|Sinque) QA (platform|tool)/.test(body || "");

// The ticket's own "Test Scenarios" field (a text area), when the Jira site has one.
const SCENARIOS_FIELD = "Test Scenarios";
let scenariosFieldId;
const scenariosField = async () => {
  if (scenariosFieldId !== undefined) return scenariosFieldId;
  const fields = await call("GET", "/rest/api/2/field");
  scenariosFieldId = fields.find(f => f.name.toLowerCase() === SCENARIOS_FIELD.toLowerCase() && f.schema?.custom?.endsWith(":textarea"))?.id || null;
  return scenariosFieldId;
};

/**
 * Puts the ticket's test cases on Jira: into its "Test Scenarios" field when the
 * ticket has one, else as one comment that later posts keep up to date.
 * Text someone typed into the field in Jira is only replaced with `overwrite`.
 */
export const postTestCases = async (rawKey, actor, { overwrite = false } = {}) => {
  const key = rawKey.toUpperCase();
  const data = readTestCases(key);
  if (!data) throw badRequest("Generate or add test cases first.");
  const wiki = testCasesToWiki(data);
  const issue = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  const fieldId = await scenariosField();
  if (fieldId) {
    const meta = await call("GET", `${issue}/editmeta`);
    if (meta.fields?.[fieldId]?.operations?.includes("set")) {
      const current = (await call("GET", `${issue}?fields=${fieldId}`)).fields?.[fieldId] || "";
      if (current.trim() && !isOurComment(current) && !overwrite) {
        throw Object.assign(new Error(`The ${SCENARIOS_FIELD} field on ${key} already has text written in Jira. Replace it with these test cases?`), { status: 409, code: "field_has_text" });
      }
      await call("PUT", issue, { body: { fields: { [fieldId]: wiki } } });
      data.jira_comment = {
        where: "field", field: SCENARIOS_FIELD, url: `${jira().baseUrl}/browse/${key}`,
        posted_at: new Date().toISOString(), posted_by: actor, fingerprint: fingerprint(data),
      };
      saveTestCases(key, data);
      return { ...data, updated: !!current.trim(), where: "field", url: data.jira_comment.url };
    }
  }
  const body = { body: wiki };
  const base = `${issue}/comment`;
  // Posted before the platform remembered its comment: adopt the newest one it wrote.
  let id = data.jira_comment?.where === "field" ? null : data.jira_comment?.id;
  if (!id) {
    const all = await call("GET", `${base}?maxResults=100&orderBy=-created`);
    id = (all.comments || []).filter(c => isOurComment(c.body)).sort((a, b) => b.created.localeCompare(a.created))[0]?.id;
  }
  let comment = null, updated = false;
  if (id) {
    try { comment = await call("PUT", `${base}/${id}`, { body }); updated = true; }
    // Deleted in Jira, or written by someone this account can't edit for: add a new one.
    catch (error) { if (!/Jira answered 404|isn't allowed/.test(error.message)) throw error; }
  }
  comment ||= await call("POST", base, { body });
  data.jira_comment = {
    where: "comment", id: comment.id, url: `${jira().baseUrl}/browse/${key}?focusedCommentId=${comment.id}`,
    posted_at: new Date().toISOString(), posted_by: actor, fingerprint: fingerprint(data),
  };
  saveTestCases(key, data);
  return { ...data, updated, where: "comment", url: data.jira_comment.url };
};

/** Tickets labelled for any of these Sinque IDs, newest first. */
export const ticketsFor = async sinqueIds => {
  const ids = [...new Set(sinqueIds.filter(Boolean))];
  if (!ids.length || !jiraEnabled()) return [];
  const jql = `project = "${jira().project}" AND labels in (${ids.map(id => `"${userLabel(id)}"`).join(",")}) ORDER BY updated DESC`;
  const res = await call("POST", "/rest/api/3/search/jql", {
    body: { jql, fields: LIST_FIELDS, maxResults: 100 },
  });
  return (res.issues || []).map(shape);
};

/** Test cases as a Jira comment (wiki markup). */
export const testCasesToWiki = d => {
  const cell = v => String(v ?? "").replace(/\|/g, "/").replace(/\n+/g, " ") || " ";
  const L = [`h3. Test cases (${d.test_cases.length})`, "", `_From the eFutures QA platform, started by ${d.generated_by} on ${d.generated_at.slice(0, 16).replace("T", " ")} UTC. Updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Edit the test cases in the platform: posting again replaces this text._`, ""];
  if (d.summary) L.push(d.summary, "");
  L.push("||ID||Test case||Kind||Priority||Steps||Expected||");
  for (const t of d.test_cases) {
    // "\\\\" in wiki markup is a line break inside a table cell.
    const br = " \\\\ ";
    L.push(`|${t.id}|${cell(t.title)}${t.preconditions ? `${br}_Given:_ ${cell(t.preconditions)}` : ""}|${t.kind}|${t.priority}|${t.steps.map((s, i) => `${i + 1}. ${cell(s)}`).join(br)}|${cell(t.expected)}${t.result ? `${br}*Result: ${t.result.pass ? "(/) pass" : "(x) fail"}*` : ""}|`);
  }
  if (d.acceptance?.length) L.push("", "*Acceptance criteria*", ...d.acceptance.map(a => `* ${a}`));
  if (d.questions?.length) L.push("", "*Open questions*", ...d.questions.map(q => `* ${q}`));
  return L.join("\n");
};
