# eFutures QA Platform

The QA platform for every eFutures project: test cases, test runs, API checks, environment health and Jira in one place, plus a **pack** of product-specific tools per project. **Sinque** is the first project with a pack: test users, scenarios and automatic checks of the weekly report on its DEV environment.

The sections from "Home" onwards describe the Sinque pack and the platform's shared features.

## Projects

Pick the project at the top of the sidebar. **Sinque** is built in and keeps all its data tools and rule checks. Admins add other products under **Team → Projects**: name, key, Jira project, environments (with health checks) and, optionally, which testers may open it.

Every project gets:
- **Test cases:**
  - suites of test cases with preconditions, steps (action and expected result), priority, tags and Jira keys;
  - **Write with AI** drafts cases from a Jira ticket or a pasted requirement; you review them before they're added;
  - on a Sinque ticket, **Add to a test suite** turns its AI test cases into suite cases.
- **Test runs:**
  - one run per release or sprint, built from suites; each run keeps a copy of the cases as they were when it started;
  - mark each case Passed, Failed, Blocked or Skipped, with keys `P` `F` `B` `S`, and add notes;
  - add screenshots by pasting with `Ctrl+V` or attaching a file; files up to 5 MB are stored in `data/projects/<KEY>/evidence`;
  - **Raise bug in Jira** from a failed case;
  - close the run and print a **sign-off report**.
- **API checks:**
  - saved requests with expectations on status, response time, a JSON value or body text, run per environment or all at once in the background;
  - tokens are never stored in a check: write `{{secret.NAME}}` and put `QA_SECRET_NAME=…` in `.env`;
  - production environments (any address containing "prod", or marked production) only allow GET.
- **Sinque API checks:** a check for each of the 151 backend endpoints, plus a "rejects without login" check for every endpoint that needs a login.
  - Generate or refresh them with `npm run sinque:api-checks`. Add `-- --replace` to rebuild the generated ones; your own checks stay.
  - The script reads the backend from `SINQUE_BACKEND_PATH` (default `../sinque-backend`).
  - Reads (GET) are switched on. Anything that changes data, needs an ID you choose, needs a partner token (`QA_SECRET_PARTNER_TOKEN`) or is heavy is added switched **off**; switch it on per check.
  - `{{login.app}}` and `{{login.dashboard}}` sign in automatically: as the platform's API test user and its test professional (kept in `data/sinque-api.json`), or as `QA_DASHBOARD_EMAIL` if that's set.
  - `{{sinque.user_id}}`, `{{sinque.sinque_id}}`, `{{sinque.group_id}}`, `{{sinque.subgroup_id}}` and `{{sinque.professional_id}}` fill in those accounts' IDs.
  - Endpoints whose login is commented out in the backend get the tag `no-login`.
  - Filter by service, switch checks on or off, and run one service at a time.
- **Environment health:** every 5 minutes the tool calls each environment's health addresses (GET only) and shows uptime and response times on Home.
- **Jira tickets:** the project's own Jira project.

Platform data lives in `data/projects.json` and `data/projects/<KEY>/`.

## Home

The tool opens on **Home**:
- **Status:** whether the database, the dev API, AI and Jira are connected.
- **Report regression:** the last **Run all presets** result (passing out of total, who ran it and when, which presets failed, and the trend over the last runs). Runs are kept in `data/preset-runs.json`.
- **Open QA tickets:** tickets raised from the tool, with their test-case progress.
- **Test data on dev:** test users, QA groups and test professionals (with how many are new this week), and test readings from the last 7 days.
- **Recent activity:** the latest audit log entries. Click one to open the ticket or user it's about.

## Background jobs

Long tasks run on the server: **Run all presets**, the **Report checker**, **Generate test cases** and **Run all scenarios** on a Jira ticket.
- A panel in the bottom-right corner shows each job's progress (e.g. "Checked 12 of 30 users"). You can keep working on other pages, or reload.
- When a job finishes you get a message in the tool, plus a browser notification if you allowed them (the browser asks the first time).
- If you're on the job's page, the result appears there by itself. From anywhere else, click **View** in the panel.
- Jobs are kept in memory for 12 hours. Restarting the tool clears them; saved results such as test cases and preset run history stay.

## Test data cleanup

**Team → Test data** lists everything the tool has created on dev: test users, groups named "QA …" and test professionals, with their age, groups, readings and access.
- **Delete test data older than N days** (default 7) shows what would be deleted before you click. It always keeps:
  - test users linked to an open Jira ticket;
  - the default "QA Scenarios" group;
  - groups with real users in them;
  - groups that still have newer test users.
- You can also tick individual items, on any tab, and delete them.
- A warning appears when a test professional (usually the overview check's bot) is group manager of **real** groups. "Remove access" deletes that professional, which removes the access; the bot is recreated when it's next needed.
- Deleting marks users, groups and professionals deleted, like the backend does. A deleted professional's manager and assignment rows are removed, because the dashboard treats any existing row as access.
- Only admins can delete in bulk. Real users and groups whose name doesn't start with "QA " are refused by the server. Every cleanup is recorded in the audit log.
- A test user's age comes from the timestamp in their email, because scenario users get a back-dated account date.

## Rules explained

**QA tools → Rules explained** describes every rule in plain English: the report week, measurement count, adherence, trend confidence, weekly weight, speed, pace, screen labels, body composition, saved reports, the overview, dashboard access, clinic billing and how this tool decides pass or fail.
- Each rule gets a one-line summary, the details, what checks it, and buttons that load a preset to test it.
- **Try it** boxes (report week, adherence, weekly weight, speed, pace, labels) run the tool's own rule code (`src/rules.js`, served to the page). They always match the rule checker; change `rules.js` and the page follows.
- Search with the box at the top; the contents list on the left follows as you scroll.

## Look and feel

- **Theme:** Auto (follows the system), Light or Dark, from the switch at the bottom of the sidebar. Remembered per browser.
- **Sidebar:** collapse it to an icon rail with the round button on its edge, or press `[`. Hover an icon to see its name. Remembered per browser.

## What you can do

| Tab | |
|---|---|
| **Users** | Find any user. See their weekly report as the dev API returns it, the raw measurements per week behind it, and their saved weekly reports. For test users: add measurements, move them to another group, reset the password and check that the app login works. |
| **Create scenario** | Create a test user from a preset (high/adequate/low adherence, fast/slow loss, gaining, onboarding, inactive, needs reactivation, black scale only, Sunday-only, two readings a day, …) or your own settings. You get the login straight away. |
| **Groups** | Create test groups and subgroups, see every group with its subgroups, codes and member counts. |
| **Professionals** | Create test professionals with a dashboard login and give them access to a group: directly, as group manager or as subgroup manager. Check that the dashboard login works. |

## Setup

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder:
   ```bash
   npm install
   cp .env.example .env
   ```
3. Fill in `.env`: the DEV database settings, and `API_BASE_URL` (the dev API, needed for reports and login checks).
4. Start it:
   ```bash
   npm start
   ```
5. Open http://localhost:4321.

## Hosting (for IT)

The platform is one Node.js process (no build step) that keeps its data in files under `data/`.

**Requirements**
- Node.js 18+ (20 LTS recommended), or Docker.
- Network access from the server to: the Sinque **DEV** database (MySQL, port 3306: VPN / IP allow-list on the RDS security group), the Sinque DEV API and admin dashboard, `*.atlassian.net` (Jira), and the AI provider in use (`api.openai.com`, `api.anthropic.com` or `generativelanguage.googleapis.com`).
- It must only ever point at **DEV**: it refuses settings whose database host isn't a dev one or that mention prod.

**Option A: Docker** (includes the browser for UI automation)
```bash
docker build -t efutures-qa .
docker run -d --name efutures-qa --restart unless-stopped   -p 4321:4321 --env-file .env   -v efutures-qa-data:/app/data -v efutures-qa-logs:/app/logs   efutures-qa
```

**Option B: plain Node.js** (Linux VM)
```bash
npm ci --omit=dev
npx playwright install --with-deps chromium   # browser for UI automation
cp .env.example .env                          # then fill it in
HOST=0.0.0.0 node src/server.js               # or run it under systemd / pm2
```

**Configuration (`.env`)**: see `.env.example`. Required on a server:
- `SESSION_SECRET`: a long random string (e.g. `openssl rand -hex 32`). Without it everyone is signed out on every restart.
- `JIRA_TOKEN_KEY`: a long random string. It encrypts the API keys, Jira tokens and saved values stored in `data/`. Keep it safe and never change it, or those can't be read any more (if it's not set, a key is generated in `data/jira.key`: then back that file up with the data).
- `QA_USERS`: the first admin account (`name:password`); more testers are added in the platform.
- The DEV database, API and dashboard settings, and an AI key. Jira and AI can also be set later on the Settings page.

**In front of it**: put it behind HTTPS (nginx, a load balancer or similar) and forward `X-Forwarded-Proto` and `X-Forwarded-For`; sign-in cookies are marked secure over HTTPS. Limit access to the company network/VPN if possible.

**Data and backups**: back up the `data/` folder (or the Docker volume) regularly. It holds testers, settings, projects, test cases, runs, screenshots and encrypted keys. `logs/` can be rotated.

**Health check**: `GET /login` answers 200 when it's up.

**Moving an existing install**: copy the `data/` folder and the `.env` values (same `SESSION_SECRET` and `JIRA_TOKEN_KEY`, or the same `data/jira.key`), so testers, settings and encrypted keys carry over.

## Test data

- Everything the tool creates uses an `@sinque-qa.example.com` email, and groups/subgroups start with `QA `. `example.com` is reserved for testing, so no email ever reaches anyone.
- All test users and professionals get the password from `TEST_PASSWORD` (default `Test@1234`).
- New test users go into the **QA Scenarios** group unless you pick another group and subgroup.
- Real users and professionals are read-only in the tool.

## QA checks

| Where | What it does |
|---|---|
| **Run all presets** | Creates a fresh QA group + subgroup, one test user per preset, and a professional (group manager) with a dashboard login. Then checks every user's report against what the preset should show and against the tool's own recalculation of the rules. One pass/fail table; about a minute. |
| Create scenario | After creating a user from a preset, the report is checked automatically and shown as ✓/✗ per field. |
| User → Report → **Overview check** | Opens the dashboard's Group/Subgroup Overview as a dashboard user and compares the user's row with their report, column by column. |
| User → Report → **Open real report page** | Opens the user's report page on the dev dashboard with a valid token. For test users the tool signs in as the user and takes the link the app gets. |
| User → Report → **Rebuild & load** | Shows "What changed" against the report loaded before, field by field. |
| User → **History** | The saved weekly reports, one row per week; cells that changed from the week before are highlighted. |

Dashboard access: the overview only counts **group manager**, **subgroup manager** and **group admin** as access. "Assign" (a direct assignment) does not make users appear in a professional's overview. Without `QA_DASHBOARD_EMAIL`/`QA_DASHBOARD_PASSWORD` in `.env`, the overview check uses the tool's own test professional "QA Overview Bot", made group manager of the user's group (recorded in the audit log).

When you add or edit a white-scale reading and leave body composition empty, the values continue from the user's own nearest white-scale reading, adjusted for the weight difference.

## Settings

**Settings** in the sidebar (under Team).

- **Everyone:** the *Your account* tab, to change your password, connect your own Jira account and pick light or dark.
- **Admins:** also get one tab per connection:

| Tab | What you can change | Test connection checks |
|---|---|---|
| **AI** | Provider (Claude, OpenAI, Gemini, automatic or off), API keys, model, daily limit per tester | the model answers |
| **Database** | Host, port, database name, username, password | sign-in, and that it has a Sinque users table |
| **Sinque app** | API and dashboard address, password for new test users, optional dashboard admin login | the API is up |
| **Jira** | Site, default project, issue type, shared account email and token | the account signs in and can see the project |

**How changes behave**

- **No restart:** saved values apply straight away.
- **Saved values win:** they're kept in `data/settings.json` and take priority over `.env`. Each field shows where its value comes from: *Set here*, *From .env* or *Default*. **Use .env** goes back to the file.
- **Secrets stay hidden:** API keys and passwords are stored encrypted, with the same key as personal Jira tokens. They never go back to the page.
- **The audit log** records who changed which setting, never the value.

**Safety**

- A database or API address that mentions "prod" is refused.
- So is a database host that doesn't mention "dev".
- A database change is tested before it's saved, so a typo can't break the platform for everyone.

`SESSION_SECRET`, `PORT`, `QA_USERS` and `JIRA_TOKEN_KEY` stay in `.env` only.

## AI tools (Claude, OpenAI or Gemini)

Pick the provider on **Settings → AI**, or set `AI_PROVIDER` with `ANTHROPIC_API_KEY` / `CLAUDE_MODEL`, `OPENAI_API_KEY` / `OPENAI_MODEL` or `GEMINI_API_KEY` / `GEMINI_MODEL` in `.env`.

- **automatic (default):** uses the first provider with a key, in the order Claude, OpenAI, Gemini.
- **OpenAI models:** GPT-5.4 mini by default; GPT-5.4 for best quality, GPT-5.4 nano for the lowest cost.
- **Claude models:** Claude Opus 5.5 by default; Sonnet 5.5 and Haiku 5.5 are cheaper.
- **Server-side fallback:** on Opus and Sonnet, if a model declines a request, Anthropic reruns it on a suitable model.
- **No key:** the AI buttons are off, and the rule checker still works.

| Where | What it does |
|---|---|
| User → Report → **Check rules** | Recalculates last week's report from the raw measurements and compares it with the dev API, field by field. No AI, no cost. |
| User → Report → **Explain with AI** | Plain-English explanation of why the report shows each value, and whether that follows the rules or looks like a bug. |
| **Report checker** | Runs the rule check over all test users or a whole group/subgroup and lists users whose report disagrees. **Summarise with AI** groups the problems into likely causes. |
| Create scenario → **Describe the user** | Type the user you need; the AI fills in the scenario settings. |
| **Test plan** | Paste a commit, PR description or diff; the AI suggests scenarios with expected results, and you can create them in one click. |
| User → Report → **Client reply** | Paste a client's complaint; the AI drafts a reply from the user's data, ready to copy or save as PDF. |
| Users → **Ask AI** | Search in plain language, e.g. "test users with low adherence who are losing fast". The AI turns it into a fixed filter; it never writes database queries. |

Privacy: the AI never receives names, emails or birth dates — only a Sinque ID, gender, age and the measurements. Client replies use a placeholder that the tool replaces with the name locally. Each tester can make at most `AI_DAILY_LIMIT` AI requests a day (default 300).

## Logins and team

Everyone signs in. On the very first start, the accounts in `QA_USERS` (in `.env`) become admins:

```
QA_USERS=alice:a-long-password
SESSION_SECRET=any-long-random-string
```

After that, accounts live in `data/testers.json` (passwords stored as bcrypt hashes; the file is not committed) and are managed in the tool:

- **Testers** page (admins): add testers (a password is generated if you leave it empty, shown once), make someone admin, reset a password, remove a tester. Resetting or removing signs that person out straight away.
- Click your own name in the sidebar to change your password.
- Passwords need at least 10 characters. After 10 wrong attempts from one address, sign-in is blocked for 15 minutes. Sessions last 12 hours.

## Audit log

Every change made through the tool is written to `logs/audit.log` and shown on the **Audit log** page, with filters for who, action, dates and free text, and the values before and after.

## Test users: delete, reset, phone login, bug report

- **Delete**: tick test users on the Users page and delete them together, or use Delete on a user's page. Users are marked deleted (like the backend does), so they disappear from the app, dashboard and overview while their records stay intact. Real users can't be deleted.
- **Reset to preset**: wipes a test user's measurements and saved reports and generates them again from a preset; email, password and group stay.
- **Phone login**: a QR code for a test user's app login. Through the shared (ngrok) link it opens a phone page with the email and password and copy buttons, valid for 30 minutes. On localhost the QR holds the login as plain text.
- **Bug report** (any user, Report tab): a summary with your notes, the profile, recent measurements, the report, the rule check and optionally the overview check. Copy or download as Markdown, save as PDF, or create a Jira ticket. "Hide name and email" (on by default for real users) leaves only the Sinque ID.

## Jira

Connects to the **SA** project on `ew2health-team.atlassian.net`. Add to `.env` and restart:

```
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
```

The account needs permission to create issues in SA.

**Personal Jira logins:** each tester can connect their own Jira account with the **Jira button** next to their name in the sidebar (Atlassian email + API token). Tickets, comments and edits they make are then done as them in Jira. Testers who haven't connected use the shared account from `.env`. If there's none, Jira features are off for them until they connect. Tokens are checked with Jira, stored encrypted (AES-256-GCM) in `data/jira-users.json`, and never shown again. The key comes from `JIRA_TOKEN_KEY` or `data/jira.key`. `JIRA_PROJECT`, `JIRA_ISSUE_TYPE` (default `Bug`) and `JIRA_BASE_URL` can be changed.

- **Bug report → Create Jira ticket**: creates the ticket with the report as its description and the Markdown attached. Labels `sinque-qa` and `sinque-user-<Sinque ID>` link it to the user.
- **User page**: shows the user's linked tickets and their status (to do / in progress / done). Tickets labelled `sinque-user-<id>` by hand in Jira show up too.
- **Report checker**: a Jira column with each flagged user's tickets.
- Real users' names and emails never go into a Jira ticket, only the Sinque ID. For test users it's up to the "Hide name and email" switch.
- Every ticket created is recorded in the audit log.

### Jira tickets page

- **List**: tickets from the QA tool, all bugs, or everything in SA, filtered by status or searched by text or key. Shows the linked users and test-case progress per ticket.
- **Ticket**: description and comments as in Jira, the linked Sinque users with a live rule check, and the ticket's test cases. Ticket chips anywhere in the tool open this page (Ctrl-click opens Jira).
- **Generate test cases** (Gemini): reads the ticket, its comments and the linked users' measurements, and writes test cases (scenario, manual, edge case, regression) with steps, exact expected results, acceptance criteria and questions for the reporter. Names, emails and phone numbers are removed before anything goes to the AI.
- **Create user & check / Run all scenarios**: creates the scenario's test user, checks its report against the rules, and links the new user to the ticket (adds its `sinque-user-<id>` label).
- **Pass / Fail** for manual cases, with a note.
- **Post to Jira** (as a comment with results), **Copy Markdown**, **CSV** (ID, title, kind, priority, preconditions, steps, expected, result).
- Test cases and results are kept in `data/testcases/<KEY>.json`, so they're still there next time.

### Sprint coverage page

For the project's Jira key: the tickets in the open sprint (or, with no open sprint, the open tickets), whether each has test cases (written on the ticket page, or project test cases that list the ticket under "Jira tickets"), and whether they've been run and pass. Filters for *No test cases*, *Not run*, *Failing*, *Passing*; "Write test cases" opens the ticket.

## API checks: import, values between checks, shapes, coverage

- **Import**: drop a **Postman collection** (v2.0/2.1) or an **OpenAPI 3 / Swagger 2** file (JSON or YAML), or paste the spec's address. You see every request, untick what you don't want, and import. Re-importing adds only new ones.
  - The collection's `{{baseUrl}}` / the spec's server is dropped: checks run against the environment you pick (OpenAPI: optional path prefix such as `/v1`).
  - Secrets are never stored: tokens, passwords and API keys become `{{secret.NAME}}`, read from `QA_SECRET_NAME` in `.env`. The import lists which ones to add.
  - Requests that change data (POST, PUT, PATCH, DELETE) come in **switched off**; a sign-in request that hands a token on stays on.
  - Postman tests (`pm.response.to.have.status`, response time, body text) become expectations; `pm.environment.set("x", …)` becomes "save from the answer".
  - OpenAPI: examples and schemas fill in bodies and ids; the success status is expected; the response schema becomes the expected shape.
- **Passing values between checks**: "Save from the answer" stores part of a response (a JSON value, a header or the status) under a name, e.g. `data.token` as `token`. Other checks use it as `{{token}}`. A check that needs a value nobody has saved yet runs the check that saves it first; "Run all" orders checks so savers run first; a 401 re-runs the login once. Values are kept per environment, encrypted, and shown masked (**Saved values**).
- **Response shape**: after a good run, **Keep this answer's shape**. From then on the check fails if a field goes missing or changes type (new fields are only reported; `null` is allowed).
- **Coverage**: after an OpenAPI import, shows which endpoints have checks, which pass or fail, and which have none.

## UI automation (no code)

On **Test cases**, **Automate** a case to run it in a hidden Chrome browser against a test environment:

- **Write the steps with AI**: the AI opens the start page, reads its buttons, fields and headings (emails, phone numbers and the contents of tables and lists are removed first) and turns the case into steps like *Type into* `field "Email"`, *Click* `button "Sign in"`, *Expect text* `Dashboard`. Edit them freely.
- **Try it**: runs the steps; every step gets a screenshot, a failed run keeps a video. Secrets (`{{secret.NAME}}`) are typed but never shown or stored in results.
- **Fix with AI**: after a failure, the AI looks at the page where it failed and suggests corrected steps (highlighted). If the app itself is broken, raise a bug instead.
- In a **test run**, **Run N automated** runs every automated case and records passed/failed with the last screenshot as evidence.
- UI tests never run on production environments. Each environment can have an **App address for UI tests** when the web app isn't at the API's address (Sinque DEV uses `DASHBOARD_URL`).
- One-time setup on the machine running the platform: `npx playwright install chromium`.

## Sharing with the team (ngrok)

1. Install ngrok and add your token once: `ngrok config add-authtoken <token>` (from dashboard.ngrok.com).
2. With the tool running: `ngrok http 4321`
3. Share the `https://….ngrok-free.app` address. Testers sign in with their `QA_USERS` login.

The link works only while this PC, the tool and ngrok are running.

## Safety

- The tool refuses to start if the database host contains `prod` or doesn't contain `dev`, or if the API address contains `prod`.
- It only listens on your own machine (`127.0.0.1`).

## Reports

The report always covers **last week** (Monday–Sunday, UTC), as the app shows it. Saved weekly reports are a cache: after adding measurements, use **Rebuild & load** so the API recalculates from the current data.
