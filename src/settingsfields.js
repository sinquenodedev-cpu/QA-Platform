// The settings an admin can change on the Settings page. Each one is an .env
// key: a value saved on the page wins over .env, and "Use .env" goes back to it.
// Pure data, so config.js can read it before anything else loads.

export const CLAUDE_MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 · best quality (default)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 · fast, cheaper" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 · fastest, cheapest" },
];

export const OPENAI_MODELS = [
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini · good balance (default)" },
  { value: "gpt-5.4", label: "GPT-5.4 · best quality" },
  { value: "gpt-5.4-nano", label: "GPT-5.4 nano · cheapest" },
];

export const SETTING_GROUPS = [
  {
    id: "ai", title: "AI", icon: "sparkle", scope: "platform",
    description: "The model behind every AI button: test cases from tickets, the report checker, test plans and AI search.",
    fields: [
      { key: "AI_PROVIDER", label: "Provider", type: "select", default: "auto",
        options: [{ value: "auto", label: "Automatic (the first with a key: Claude, OpenAI, Gemini)" }, { value: "claude", label: "Claude (Anthropic)" }, { value: "openai", label: "OpenAI (ChatGPT models)" }, { value: "gemini", label: "Gemini (Google)" }, { value: "off", label: "Off" }] },
      { key: "ANTHROPIC_API_KEY", label: "Claude API key", type: "password", secret: true, show: { AI_PROVIDER: ["auto", "claude"] },
        help: "From console.anthropic.com → API keys. Starts with sk-ant-." },
      { key: "CLAUDE_MODEL", label: "Claude model", type: "select", default: "claude-opus-5-5", options: CLAUDE_MODELS, show: { AI_PROVIDER: ["auto", "claude"] } },
      { key: "OPENAI_API_KEY", label: "OpenAI API key", type: "password", secret: true, show: { AI_PROVIDER: ["auto", "openai"] },
        help: "From platform.openai.com → API keys. Starts with sk-. Uses your OpenAI API credit." },
      { key: "OPENAI_MODEL", label: "OpenAI model", type: "select", default: "gpt-5.4-mini", options: OPENAI_MODELS, show: { AI_PROVIDER: ["auto", "openai"] } },
      { key: "GEMINI_API_KEY", label: "Gemini API key", type: "password", secret: true, show: { AI_PROVIDER: ["auto", "gemini"] },
        help: "From aistudio.google.com → Get API key." },
      { key: "GEMINI_MODEL", label: "Gemini model", type: "text", default: "gemini-2.5-flash", show: { AI_PROVIDER: ["auto", "gemini"] } },
      { key: "AI_DAILY_LIMIT", label: "AI requests per tester per day", type: "number", default: "300",
        help: "Stops a loop or a big scan from running up the bill." },
    ],
  },
  {
    id: "database", title: "Sinque database", icon: "db", scope: "sinque",
    description: "The Sinque database the data tools read and write. DEV only: hosts that mention “prod”, or don't mention “dev”, are refused.",
    fields: [
      { key: "DATABASE_HOST", label: "Host", type: "text", required: true, placeholder: "dev-sinque.cluster-xxxx.eu-north-1.rds.amazonaws.com" },
      { key: "DATABASE_PORT", label: "Port", type: "number", default: "3306" },
      { key: "DATABASE_NAME", label: "Database name", type: "text", required: true, placeholder: "sinque-dev" },
      { key: "DATABASE_USERNAME", label: "Username", type: "text" },
      { key: "DATABASE_PASSWORD", label: "Password", type: "password", secret: true },
    ],
  },
  {
    id: "sinque", title: "Sinque app", icon: "cloud", scope: "sinque",
    description: "The Sinque API and dashboard of the same environment as the database, and the logins the tool uses.",
    fields: [
      { key: "API_BASE_URL", label: "API address", type: "url", placeholder: "https://sinque-dev.efuturesworld.com", help: "No trailing slash. Addresses with “prod” are refused." },
      { key: "DASHBOARD_URL", label: "Dashboard address", type: "url", default: "https://dev-sinqueadmin.efuturesworld.com" },
      { key: "TEST_PASSWORD", label: "Password for new test users", type: "text", default: "Test@1234",
        help: "Given to every test user and professional the tool creates from now on. Existing ones keep their old password." },
      { key: "QA_DASHBOARD_EMAIL", label: "Dashboard admin email (optional)", type: "text",
        help: "A role 2 admin for the overview check. Without it the tool uses its own test professional." },
      { key: "QA_DASHBOARD_PASSWORD", label: "Dashboard admin password", type: "password", secret: true },
    ],
  },
  {
    id: "jira", title: "Jira", icon: "ticket", scope: "platform",
    description: "The Jira site for every project, and the shared account used by testers who haven't connected their own. Each project picks its own Jira project key in its project settings.",
    fields: [
      { key: "JIRA_BASE_URL", label: "Jira site", type: "url", default: "https://ew2health-team.atlassian.net" },
      { key: "JIRA_PROJECT", label: "Sinque Jira project key", type: "text", default: "SA", help: "Used by the Sinque project. Other projects set their own key in their project settings." },
      { key: "JIRA_ISSUE_TYPE", label: "Issue type for bugs", type: "text", default: "Bug" },
      { key: "JIRA_EMAIL", label: "Shared account email", type: "text" },
      { key: "JIRA_API_TOKEN", label: "Shared account API token", type: "password", secret: true,
        help: "From id.atlassian.com → Security → API tokens." },
    ],
  },
];

export const SETTING_FIELDS = SETTING_GROUPS.flatMap(g => g.fields.map(f => ({ ...f, group: g.id })));
export const SETTING_KEYS = SETTING_FIELDS.map(f => f.key);

/** Why a value is refused for DEV-only settings, or null when it's fine. */
export const devGuard = (key, value) => {
  if (!value) return null;
  if ((key === "DATABASE_HOST" || key === "API_BASE_URL" || key === "DASHBOARD_URL") && /prod/i.test(value)) {
    return `${value} looks like production. This platform only runs against DEV.`;
  }
  if (key === "DATABASE_HOST" && !/dev/i.test(value)) return `${value} doesn't look like a DEV database (the host should mention “dev”).`;
  return null;
};
