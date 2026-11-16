import type { Env } from "./types";
import { cleanupStorage } from "./file-coordinator";

const ALERT_REPO_OWNER = "50R1Paps";
const ALERT_REPO_NAME = "second-brain-worker";
const REMINDER_TITLE = "[Token Expiry Reminder] GITHUB_TOKEN in scadenza";
const ALERT_DAYS_BEFORE = 2;

type FetchFunction = typeof fetch;

/** Aggregate metrics are retained for 30 days; raw searches are never retained. */
export async function runMaintenance(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM request_counters WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM webhook_receipts WHERE expires_at < ?").bind(now),
    env.DB.prepare("UPDATE retrieve_metrics SET query = '' WHERE query <> ''"),
    env.DB.prepare("DELETE FROM retrieve_metrics WHERE created_at < datetime('now', '-30 days')"),
  ]);
  await cleanupStorage(env);
  console.info(JSON.stringify({ event: "maintenance_complete" }));
}

export async function handleScheduled(
  env: Env,
  fetchFn: FetchFunction = fetch,
): Promise<void> {
  const expiry = env.GITHUB_TOKEN_EXPIRY;
  if (!expiry) return;

  const expiryDate = new Date(expiry);
  if (isNaN(expiryDate.getTime())) return;

  const now = new Date();
  const msUntilExpiry = expiryDate.getTime() - now.getTime();
  const daysUntilExpiry = Math.ceil(msUntilExpiry / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry > ALERT_DAYS_BEFORE) return;
  if (daysUntilExpiry < -30) return;

  if (await findOpenIssue(env, fetchFn, REMINDER_TITLE)) return;

  await createReminderIssue(env, fetchFn, daysUntilExpiry);
}

export function githubHeaders(env: Env): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "second-brain-worker",
  };
}

/** Finds the open alert issue with this exact title, so each alert has at most one open issue. */
export async function findOpenIssue(
  env: Env,
  fetchFn: FetchFunction,
  title: string,
): Promise<{ number: number; title: string } | undefined> {
  const url = `https://api.github.com/repos/${ALERT_REPO_OWNER}/${ALERT_REPO_NAME}/issues?state=open&per_page=100`;
  const response = await fetchFn(url, { headers: githubHeaders(env) });

  if (!response.ok) throw new Error(`GitHub issue lookup failed (HTTP ${response.status})`);

  const issues = (await response.json()) as Array<{ number: number; title: string }>;
  return issues.find((issue) => issue.title === title);
}

/** Updates the open alert issue with this title, or opens it when none is open. */
export async function upsertIssue(
  env: Env,
  fetchFn: FetchFunction,
  issue: { title: string; body: string; label: string },
): Promise<"created" | "updated"> {
  const existing = await findOpenIssue(env, fetchFn, issue.title);
  const base = `https://api.github.com/repos/${ALERT_REPO_OWNER}/${ALERT_REPO_NAME}/issues`;
  const response = await fetchFn(existing ? `${base}/${existing.number}` : base, {
    method: existing ? "PATCH" : "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(existing ? { body: issue.body } : { title: issue.title, body: issue.body, labels: [issue.label] }),
  });
  if (!response.ok) throw new Error(`GitHub issue ${existing ? "update" : "creation"} failed (HTTP ${response.status})`);
  return existing ? "updated" : "created";
}

async function createReminderIssue(
  env: Env,
  fetchFn: FetchFunction,
  daysUntilExpiry: number,
): Promise<void> {
  const url = `https://api.github.com/repos/${ALERT_REPO_OWNER}/${ALERT_REPO_NAME}/issues`;
  const expiry = env.GITHUB_TOKEN_EXPIRY;

  const body =
    daysUntilExpiry >= 0
      ? `Il **GITHUB_TOKEN** scade tra **${daysUntilExpiry} giorno${daysUntilExpiry === 1 ? "" : "i"}** (${expiry}).\n\n` +
        `Per aggiornarlo:\n\n` +
        `1. Crea un nuovo token su [GitHub Settings > Tokens](https://github.com/settings/tokens) con scope \`repo\`\n` +
        `2. Aggiorna il secret su Cloudflare:\n\n` +
        `\`\`\`bash\n` +
        `npx wrangler secret put GITHUB_TOKEN\n` +
        `npx wrangler secret put GITHUB_TOKEN_EXPIRY\n` +
        `\`\`\`\n\n` +
        `3. Incolla il nuovo token e la nuova data di scadenza (formato ISO, es. \`2026-09-25T00:00:00Z\`)\n` +
        `4. Chiudi questa issue\n\n` +
        `> Issue generata automaticamente dal Cron Trigger di Second Brain Worker.`
      : `Il **GITHUB_TOKEN** è scaduto il ${expiry} (${Math.abs(daysUntilExpiry)} giorni fa).\n\n` +
        `Il webhook sync non funzionerà fino all'aggiornamento del token.\n\n` +
        `Per aggiornarlo:\n\n` +
        `1. Crea un nuovo token su [GitHub Settings > Tokens](https://github.com/settings/tokens) con scope \`repo\`\n` +
        `2. Aggiorna i secret su Cloudflare:\n\n` +
        `\`\`\`bash\n` +
        `npx wrangler secret put GITHUB_TOKEN\n` +
        `npx wrangler secret put GITHUB_TOKEN_EXPIRY\n` +
        `\`\`\`\n\n` +
        `3. Incolla il nuovo token e la nuova data di scadenza (formato ISO, es. \`2026-09-25T00:00:00Z\`)\n` +
        `4. Chiudi questa issue\n\n` +
        `> Issue generata automaticamente dal Cron Trigger di Second Brain Worker.`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: REMINDER_TITLE,
      body,
      labels: ["token-expiry-reminder"],
    }),
  });
  if (!response.ok) throw new Error(`Token reminder creation failed (HTTP ${response.status})`);
}
