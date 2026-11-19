# eFutures QA Platform: Scope

> One QA platform for every eFutures project: set up test data, check results automatically, run and sign off releases, and track bugs in Jira, in one place.

---

## Contents

1. [Purpose](#1-purpose)
2. [How the platform is organised](#2-how-the-platform-is-organised)
3. [Features for every project](#3-features-for-every-project)
4. [The Sinque pack (first project)](#4-the-sinque-pack-first-project)
5. [AI features](#5-ai-features)
6. [Out of scope](#6-out-of-scope)
7. [Architecture](#7-architecture)
8. [Safety and data protection](#8-safety-and-data-protection)
9. [Hosting](#9-hosting)
10. [Risks and open points](#10-risks-and-open-points)
11. [Roadmap](#11-roadmap)
12. [Who uses it](#12-who-uses-it)

---

## 1. Purpose

Testers spend much of their time on work that isn't testing:
- building the right test data by hand;
- working out by hand what a screen should show;
- copying results into spreadsheets and tickets.

The platform takes that work away:

| Question a tester has | How the platform answers it |
|---|---|
| *How do I get the exact situation I need?* | Creates realistic test users, groups and data in seconds (per product). |
| *Is this result actually right?* | Recalculates the expected result from the raw data and compares it with what the system returns. |
| *What did we test for this release, and did it pass?* | Test suites, test runs, evidence and a sign-off report. |
| *Is the environment even up?* | Health checks and API checks per environment. |
| *What's broken and who's on it?* | Bugs go to Jira with everything a developer needs, and ticket status shows next to the test data. |

The platform belongs to **eFutures**, not to any one product. Each eFutures product is a **project** on it. It runs on its own, outside every product's codebase, and works only against **test environments**.

---

## 2. How the platform is organised

```
                  ┌─────────────────────────────────────────────┐
                  │           eFutures QA Platform              │
                  │                                             │
                  │  Core (every project)                       │
                  │   Test cases · Test runs · API checks ·     │
                  │   Environment health · Jira · AI ·          │
                  │   Accounts · Audit log · Background jobs    │
                  │                                             │
                  │  Packs (product-specific)                   │
                  │   ┌──────────────┐  ┌──────────────┐        │
                  │   │ Sinque pack  │  │ Next project │  …     │
                  │   └──────────────┘  └──────────────┘        │
                  └─────────────────────────────────────────────┘
```

- **Project:** one eFutures product. Each project has its own environments (DEV, QA, STAGING, …), its own Jira project and its own testers.
- **Core:** the features every project gets on day one, with no product-specific code.
- **Pack:** the product-specific part: access to its test data, its business rules as automatic checks, and its own tools. A pack is what no off-the-shelf test tool can offer.

Testers switch project from the top of the sidebar; the menu shows only what that project has.

| Project | Status |
|---|---|
| **Sinque** | First project, live with the full Sinque pack |
| **Demo Shop** | Sample project showing the core features against public test APIs |
| **Other eFutures projects** | Added by an admin under *Projects*: the core features work from day one; a pack follows once QA has access to the project's test data and its rules are written down |

---

## 3. Features for every project

### 3.1 Test cases
- Suites group test cases by area (e.g. *Sign-in*, *Checkout*).
- Each case has a title, preconditions, numbered steps (action and expected result), a priority, tags and linked Jira tickets.
- **Write with AI:** draft cases from a Jira ticket or a pasted requirement. The tester reviews them and picks which to keep.
- Search and filter by text, tag, Jira key or priority.

### 3.2 Test runs
- One run per release, sprint or hotfix, built from one or more suites.
- A run keeps a copy of each case as it was when the run started, so later edits don't change past results.
- **Marking results:**
  - Passed, Failed, Blocked or Skipped, with keyboard shortcuts (`P` `F` `B` `S`);
  - after each result the next open case comes up, so a tester can work through a run quickly.
- **Evidence:** notes, plus screenshots pasted straight in (`Ctrl+V`) or attached as files.
- **Raise bug in Jira** from a failed case. The ticket includes the steps, the note and a link back to the run.
- **Sign-off report:** totals, failed and blocked cases with their Jira tickets, and every case with who tested it. Print to PDF or copy as Markdown.
- Close a run when it's done; closed runs can't be changed until they're reopened.

### 3.3 API checks
- Saved requests (GET, POST, PUT, PATCH, DELETE) with expectations:
  - status code;
  - response time;
  - a value in the JSON (e.g. `data.items[0].name`), compared with `=`, `>`, `contains`, `exists` and others;
  - text in the body.
- Run one check or all of them on any environment. Running all of them happens in the background.
- History of every run with the full response.
- **Secrets are never stored in a check:** `{{secret.NAME}}` is read from the server's configuration when the check runs.
- **Production environments only allow GET**, so a check can never change live data.

### 3.4 Environment health
- Each environment lists health addresses (e.g. `/health`).
- The platform calls them every 5 minutes (GET only) and shows up/down, response time and uptime on Home.

### 3.5 Jira
- Each project uses its own Jira project; the tickets list is filtered by status or searched by text and key.
- Ticket page: description, comments, linked test users, and test cases written from the ticket.
- Every ticket the platform creates carries the label `qa-platform` plus one for its project (e.g. `qa-sinque`), so tickets can be traced back across all eFutures projects.

### 3.6 Everyday use
| Feature | What it does |
|---|---|
| **Home** | Environment health, test runs in progress, API checks or regression results, open tickets, recent activity |
| **Background jobs** | Long tasks keep running while the tester works elsewhere; a panel shows progress and a notification says when they're done |
| **Accounts** | Personal logins with admin and tester roles; access per project |
| **Audit log** | Every change made through the platform: who, what, when, before and after |
| **Interface** | Responsive (works on phones), light/dark/auto theme, collapsible sidebar |

---

## 4. The Sinque pack (first project)

What the Sinque project adds on top of the core. It's also the template for packs for other eFutures projects.

### 4.1 Test data
| Feature | What it does |
|---|---|
| **User search** | Any dev user by name, email or Sinque ID, or in plain language |
| **User page** | Profile, groups, weekly activity chart, measurements per week, saved weekly reports and their history |
| **Measurements** | Add, edit or delete readings (date, time, weight, body composition). Body composition left empty is filled in from the user's own nearest white-scale reading. |
| **Create scenario** | 16 ready-made user types, or custom settings: high/adequate/low adherence, fast/slow loss, gaining, onboarding, inactive, needs reactivation, black scale only, Sunday-only, two readings a day and more |
| **Groups and professionals** | QA groups and subgroups; test professionals with dashboard logins and access as group manager, subgroup manager or by direct assignment |
| **Test user tools** | Reset password, check the app login works, move group, reset to a preset, delete, QR code to log in on a phone |
| **Test data cleanup** | Everything the platform has created, with "delete what's older than N days". It keeps users on open tickets and groups that are still in use. |

### 4.2 Automatic checks
| Check | What it does |
|---|---|
| **Rule check** | Recalculates last week's report from raw readings and compares it field by field with the dev API |
| **Run all presets** | One-click regression: a fresh group, one user per preset and a group-manager login, then every report checked. Results are kept, with a trend over past runs. |
| **Report checker** | The rule check over all test users or a whole group, listing every mismatch |
| **Overview check** | Compares a user's row in the dashboard's Group/Subgroup Overview with their report |
| **Real report page** | Opens the user's report on the dev dashboard with a valid link |
| **Rebuild & load** | Recalculates a saved report and shows what changed |

### 4.3 Rules explained
Every weekly-report rule in plain English:
- the report week, adherence and trend confidence;
- the most reliable weekly weight, speed and pace;
- body composition, saved reports and the overview;
- dashboard access and clinic billing.

Interactive examples let testers change the inputs and see the result. They run the same code as the automatic checks, so the page always agrees with them.

### 4.4 Jira for Sinque
- **Bug report → ticket:** profile, report, rule check and measurements, with the full report attached.
- **Linking:** tickets are linked to users by the label `sinque-user-<id>`. Linked tickets and their status show on the user page and in the Report checker.
- **Test cases from a ticket** use the linked users' real measurements (anonymised). Scenario cases become test users and are checked against the rules in one click.

---

## 5. AI features

| Feature | Available in |
|---|---|
| Test cases from a Jira ticket or requirement | Every project |
| Test cases from a ticket **using the linked users' data**, runnable in one click | Sinque |
| Explain a user's report: why each value is what it is, and whether it's a bug | Sinque |
| Summarise Report checker results into likely causes | Sinque |
| Describe a test user in words → scenario settings | Sinque |
| Test plan from a commit, pull request or diff | Sinque |
| Draft a reply to a client's question about a report | Sinque |
| Search users in plain language | Sinque |

**Why this matters:** Jira add-ons can write test cases from ticket text. Here the AI works with the product's own data and rules, and its output can be run and checked automatically.

**Privacy rules for AI:**
- Names, emails and birth dates are never sent; only IDs, gender, age and measurements.
- Text from Jira or a requirement has emails and phone numbers removed first.
- Each tester has a daily request limit.
- Provider: Google Gemini (`gemini-2.5-flash`).

---

## 6. Out of scope

| Not included | Why |
|---|---|
| Writing to production | The platform refuses to start against a production database; production environments only allow read-only checks |
| Testing app screens (UI automation) | The platform checks data, APIs and results, not pixels |
| Load and performance testing | Needs dedicated tools |
| Changing product code | The platform only uses test data, APIs and Jira |
| Automated clinic reconciliation (Sinque billing) checks | Documented in Rules explained; automation is on the roadmap |

---

## 7. Architecture

```
 Testers (browser, phone)
        │  HTTPS
        ▼
 eFutures QA Platform server (Node.js)
   ├─ Product test databases      (Sinque: MySQL dev)
   ├─ Product APIs                (per environment)
   ├─ Jira Cloud REST API         (tickets, comments, labels)
   └─ Google Gemini API           (AI, anonymised input only)
```

| Part | Choice |
|---|---|
| Server | Node.js 18+ (ES modules), built-in `http` module, no framework |
| Libraries | `mysql2`, `bcryptjs`, `dotenv`, `@google/generative-ai`, `qrcode` |
| Front end | One HTML page with plain JavaScript and CSS; served by the same server, no build step |
| Rule checks (Sinque) | `src/rules.js`: an independent implementation of the weekly-report rules, kept in step with the backend |
| Platform data | JSON files in `data/`: projects, test cases, runs, evidence, API checks, tester accounts |
| Logs | `logs/audit.log` |
| Configuration | `.env`: database, APIs, Jira, AI and session settings; never committed |

---

## 8. Safety and data protection

| Safeguard | Detail |
|---|---|
| **Test environments only** | Refuses to start if the database host looks like production or isn't DEV |
| **Test data is clearly marked** | Each pack marks its test data. Sinque: test emails end `@sinque-qa.example.com`, a domain reserved for testing, so no mail is ever delivered; test groups start with `QA ` |
| **Real data is protected** | The server refuses to bulk-delete real users or groups; deletes are soft (marked deleted), like the product does |
| **Production APIs are read-only** | Any environment marked production, or with "prod" in its address, only allows GET |
| **Secrets stay on the server** | API check tokens, Jira and AI keys live in `.env`; checks only reference them by name |
| **Personal data stays inside** | Real users' names and emails never go to Jira or the AI |
| **Evidence files** | Only images, PDF and text, up to 5 MB, served only to signed-in testers |
| **Accounts** | Passwords stored as bcrypt hashes; 12-hour sessions; sign-in locked for 15 minutes after 10 failed attempts |
| **Audit** | Every change recorded with the tester's name |

---

## 9. Hosting

| | Today | Target |
|---|---|---|
| **Where** | A developer PC, shared through an ngrok tunnel | A small internal server (e.g. AWS Lightsail or EC2) in the test network, behind company sign-in or VPN |
| **Availability** | While that PC is on | Always on |
| **Data** | JSON files on the PC | A managed database with daily backups |
| **Effort** | — | About a day for the server; a few days to move platform data into a database |

The front end and back end run as one process, so one server is all it needs.

---

## 10. Risks and open points

| # | Topic | Detail | Proposed action |
|---|---|---|---|
| 1 | **Real data in the Sinque dev database** | The Sinque dev database contains copies of real users and measurements. The platform can edit real users' measurements there; every change is audited. | Agree which database the platform may write to. Make real users read-only, or move testing to a database with test data only. |
| 2 | **Test login with access to real clinics** | The overview check gave its test professional group-manager access to four real clinic groups. | Remove that access (one click on the Test data page). Switch the overview check to a dashboard admin login. |
| 3 | **Shared secrets** | Some tokens were shared in chat during setup. | Rotate them. Use a service account for Jira. |
| 4 | **AI provider credit** | The current Gemini key has run out of credit, so AI features fail. | A company key with a budget limit. |
| 5 | **Rule drift** | The platform's Sinque rules must follow the backend's weekly-report calculation. | Add "update the QA platform rules" to the backend release checklist. |
| 6 | **Platform data in files** | Test cases, runs and evidence are files on one machine. | Move to a database with backups when hosting is set up. |
| 7 | **Source control and ownership** | The platform isn't in a git repository yet, and its folder still carries a Sinque name. | Create an eFutures repository (e.g. `efutures-qa-platform`); keep `.env`, `data/` and `logs/` out of it. |

---

## 11. Roadmap

| Phase | Item | Why |
|---|---|---|
| **Now** | Close risks 1–3 and 7 | Safety and ownership |
| **Next** | Internal hosting with a database and backups | The whole team can use it without a developer PC |
| | Shareable links to every page (users, tickets, runs, results) | Links in Jira and chat |
| | Run history for the Report checker: "what changed since the last deploy" | Catches regressions right after a release |
| **Then** | Sinque clinic reconciliation checks: a generated clinic sheet covering every billing tile, uploaded and checked automatically | Billing is revenue |
| | Who-sees-what checks for every dashboard role | A leak between clinics is the worst failure |
| | Onboard the next eFutures projects: core features first, then a pack each | One QA platform across eFutures |
| **Later** | Company sign-in (Google/Microsoft) | One login, easier on- and off-boarding |
| | Scheduled runs (API checks and regression every night) with alerts | Problems found before testers start their day |

---

## 12. Who uses it

| Role | Use |
|---|---|
| **QA testers (all eFutures projects)** | Every day: test data, test runs, checks, bugs |
| **Developers** | Reproduce a bug with a ready-made user; check a fix against the rules and API checks |
| **Product and support** | Read *Rules explained*; draft answers to client questions |
| **Team leads** | Sign-off reports per release; Home for the state of each environment |
| **Admins** | Projects, environments, tester accounts, test data cleanup, audit log |
