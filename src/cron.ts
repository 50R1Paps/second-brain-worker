import type { Env } from "./handlers";

const ALERT_REPO_OWNER = "50R1Paps";
const ALERT_REPO_NAME = "second-brain-worker";
const REMINDER_TITLE = "[Token Expiry Reminder] GITHUB_TOKEN in scadenza";
const ALERT_DAYS_BEFORE = 2;

type FetchFunction = typeof fetch;

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

  const hasOpenIssue = await checkExistingReminder(env, fetchFn);
  if (hasOpenIssue) return;

  await createReminderIssue(env, fetchFn, daysUntilExpiry);
}

async function checkExistingReminder(
  env: Env,
  fetchFn: FetchFunction,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${ALERT_REPO_OWNER}/${ALERT_REPO_NAME}/issues?state=open&per_page=100`;
  const response = await fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "second-brain-worker",
    },
  });

  if (!response.ok) return false;

  const issues = (await response.json()) as Array<{ title: string }>;
  return issues.some((issue) => issue.title === REMINDER_TITLE);
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

  await fetchFn(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "second-brain-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: REMINDER_TITLE,
      body,
      labels: ["token-expiry-reminder"],
    }),
  });
}
