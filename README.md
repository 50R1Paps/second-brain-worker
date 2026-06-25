# Second Brain Worker

Un knowledge base personale **serverless** su Cloudflare Workers che indicizza la tua [wiki Obsidian](https://github.com/50R1Paps/Mysecondbrain) e file esterni, con ricerca ibrida (semantica + keyword) accessibile via **MCP (Model Context Protocol)** direttamente dal tuo IDE.

## Cos'è

Second Brain Worker è un Cloudflare Worker che:

- **Indicizza** file markdown dalla wiki Obsidian e file esterni (PDF, articoli, testo)
- **Chunka** il contenuto rispettando la struttura delle sezioni (`##`/`###`), preservando frontmatter e wikilink
- **Genera embedding** semantici via Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dim)
- **Memorizza** tutto in R2 (raw), D1 (metadata + FTS5 keyword search), e Vectorize (embedding)
- **Espone 3 tool MCP** — `retrieve`, `ingest`, `reindex` — accessibili dal tuo IDE via OAuth GitHub
- **Sincronizza** automaticamente la wiki via GitHub webhook: quando fichi push su `main`, i file `.md` cambiati vengono re-indicizzati

Tutto entro il **free tier** di Cloudflare.

---

## Architettura

```
                    ┌─────────────────────────────────────────────┐
                    │              Cloudflare Worker               │
                    │                                              │
   GitHub Webhook ──▶  /webhook/github  ──▶  fetch .md  ──▶  R2   │
                    │                                  │           │
   REST API ────────▶  /api/ingest      ──▶  chunker    │           │
                    │  /api/retrieve    ──▶  embedder   │           │
                    │  /api/reindex     ──▶  D1 + Vectorize        │
                    │  /api/health      │           │               │
                    │                   │           │               │
   MCP Client ─────▶  /mcp (OAuth)      │           │               │
                    │  /authorize       │           │               │
                    │  /callback        │           │               │
                    └─────────────────────────────────────────────┘
                           │         │           │
                    ┌──────▼──┐ ┌───▼────┐ ┌────▼──────┐
                    │   R2    │ │   D1   │ │ Vectorize │
                    │ (raw)   │ │(meta + │ │ (embedding│
                    │         │ │  FTS5) │ │  vectors) │
                    └─────────┘ └────────┘ └───────────┘
```

### Componenti

- **R2** (`RAW_BUCKET`) — storage del contenuto raw dei file
- **D1** (`DB`) — database SQLite con tabelle `files`, `chunks`, e tabella virtuale FTS5 `chunks_fts` per keyword search
- **Vectorize** (`VECTORIZE`) — indice di embedding semantici (768 dimensioni)
- **Workers AI** (`AI`) — modello `bge-base-en-v1.5` per generazione embedding
- **KV** (`OAUTH_KV`) — storage di stato/CSRF token per il flow OAuth
- **Durable Object** (`SECOND_BRAIN_MCP`) — McpAgent che mantiene la sessione MCP
- **OAuth Provider** — integrazione `@cloudflare/workers-oauth-provider` con GitHub OAuth

---

## MCP Tools

Il server MCP espone 3 tool accessibili dal tuo IDE:

### `retrieve`

Ricerca ibrida nel knowledge base: query semantica via Vectorize + query keyword via D1 FTS5. I risultati vengono fusi (merge) con pesi 50/50, ordinati per score combinato, e arricchiti con metadata dal D1.

**Parametri:**

- `query` (string, required) — query in linguaggio naturale o keyword
- `limit` (number, default 10, max 50) — numero massimo di risultati
- `file_type` (`"wiki_page"` | `"ingested"`, optional) — filtra per tipo di file
- `section_prefix` (string, optional) — filtra per prefisso sezione (es. `## Architecture`)
- `file_key_prefix` (string, optional) — filtra per prefisso file key (es. `wiki/concepts/`)

### `ingest`

Carica un file nel knowledge base: il contenuto viene chunkato, embeddato, e salvato in R2 + D1 + Vectorize. Se il file esiste già, i vecchi chunk e vector vengono sostituiti.

**Parametri:**

- `file_key` (string, required) — identificatore univoco. Per wiki page: path relativo (es. `wiki/concepts/Tool Attention.md`). Per file esterni: `filename:uuid`
- `content` (string, required) — contenuto testuale completo
- `file_type` (`"wiki_page"` | `"ingested"`, required) — tipo di file
- `title` (string, optional) — titolo del file
- `source` (string, optional) — URL o path sorgente

### `reindex`

Re-indicizza un file specifico o tutti i file. Legge il raw da R2, re-esegue chunking + embedding, aggiorna Vectorize e D1.

**Parametri:**

- `file_key` (string, optional) — file da re-indicizzare. Se omesso, re-indicizza tutti i file

---

## REST API

Oltre ai tool MCP, il Worker espone endpoint REST (non autenticati, utili per script e setup):

| Metodo | Endpoint          | Descrizione                                      |
| ------ | ----------------- | ------------------------------------------------ |
| GET    | `/api/health`     | Stato del Worker: file indicizzati, chunk totali |
| POST   | `/api/ingest`     | Ingest di un file (stesso formato del tool MCP)  |
| POST   | `/api/retrieve`   | Retrieve ibrido (stesso formato del tool MCP)    |
| POST   | `/api/reindex`    | Reindex di un file o di tutti                    |
| POST   | `/webhook/github` | Webhook GitHub per sync automatico               |

---

## Prerequisiti

- **Node.js** 22+
- **Account Cloudflare** (free tier sufficiente)
- **GitHub OAuth App** — per l'autenticazione MCP
- **Wiki Obsidian** in un repo GitHub (se vuoi usare il sync automatico)

---

## Setup completo

### 1. Clona e installa

```bash
git clone https://github.com/50R1Paps/second-brain-worker.git
cd second-brain-worker
npm install
```

### 2. Crea le risorse Cloudflare

Esegui questi comandi con `wrangler` per creare le risorse necessarie:

```bash
# Crea R2 bucket
npx wrangler r2 bucket create second-brain-raw

# Crea D1 database
npx wrangler d1 create second-brain
# Annota il database_id dal output

# Crea KV namespace per OAuth
npx wrangler kv namespace create OAUTH_KV
# Annota l'id dal output

# Crea Vectorize index (768 dim per bge-base-en-v1.5)
npx wrangler vectorize create second-brain-embeddings --dimensions 768 --metric cosine
```

### 3. Configura `wrangler.toml`

Copia il file di esempio e compila i valori reali:

```bash
cp wrangler.toml.example wrangler.toml
```

Modifica `wrangler.toml` sostituendo `<your-d1-database-id>` e `<your-kv-namespace-id>` con i valori ottenuti al passo 2.

### 4. Applica la migration D1

```bash
# Locale (per dev)
npm run db:migrate

# Remoto (per produzione)
npm run db:migrate:remote
```

### 5. Crea una GitHub OAuth App

1. Vai su [GitHub Settings > Developer settings > OAuth Apps > New OAuth App](https://github.com/settings/developers)
2. Compila:
   - **Application name:** Second Brain MCP
   - **Homepage URL:** `https://second-brain.<tuo-subdomain>.workers.dev`
   - **Authorization callback URL:** `https://second-brain.<tuo-subdomain>.workers.dev/callback`
3. Annota il **Client ID** e genera un **Client Secret**

### 6. Imposta i segreti

```bash
# OAuth
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY

# GitHub webhook sync (opzionale, solo se usi il sync automatico)
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
```

Per `COOKIE_ENCRYPTION_KEY` puoi generare una stringa casuale con:

```bash
openssl rand -hex 32
```

Per `GITHUB_TOKEN`, crea un [Personal Access Token](https://github.com/settings/tokens) con scope `repo` (per leggere i file `.md` via API).

Per `WEBHOOK_SECRET`, genera un'altra stringa casuale e usala anche come secret del webhook GitHub.

### 7. Deploy

```bash
npm run deploy
```

Annota l'URL del Worker (es. `https://second-brain.<tuo-subdomain>.workers.dev`).

### 8. Inizializza il knowledge base (setup script)

Se hai la wiki Obsidian in locale, puoi ingerire tutti i file `.md` con lo script di setup:

```bash
# Locale (durante dev)
npm run setup -- --wiki-dir /path/to/wiki --url http://localhost:8787

# Remoto (dopo deploy)
npm run setup -- --wiki-dir /path/to/wiki --url https://second-brain.<tuo-subdomain>.workers.dev

# Dry run (lista file senza ingerire)
npm run setup:dry -- --wiki-dir /path/to/wiki
```

### 9. Configura il webhook GitHub (opzionale)

Per sincronizzare automaticamente la wiki quando fichi push su `main`:

1. Vai su [GitHub > Your Repo > Settings > Webhooks > Add webhook](https://github.com/50R1Paps/Mysecondbrain/settings/hooks/new)
2. Compila:
   - **Payload URL:** `https://second-brain.<tuo-subdomain>.workers.dev/webhook/github`
   - **Content type:** `application/json`
   - **Secret:** lo stesso valore di `WEBHOOK_SECRET`
   - **Trigger:** "Just the push event"
3. Salva

Da ora, ogni push su `main` che modifica file `.md` in `wiki/` triggera la re-indicizzazione automatica.

---

## Gestione dei secret

I secret sono gestiti via `wrangler secret put` e stored nella dashboard Cloudflare (mai nel codice). Ecco quando aggiornarli:

| Secret                  | Scade?                                             | Quando aggiornare                                                                                      |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN`          | **Sì** — scade in base alla configurazione del PAT | Quando il Personal Access Token scade: `npx wrangler secret put GITHUB_TOKEN` e incolla il nuovo token |
| `GITHUB_CLIENT_ID`      | No                                                 | Solo se revochi/ricrei l'OAuth App su GitHub                                                           |
| `GITHUB_CLIENT_SECRET`  | No                                                 | Solo se revochi/ricrei l'OAuth App su GitHub                                                           |
| `COOKIE_ENCRYPTION_KEY` | No                                                 | Mai (a meno che tu non voglia invalidare tutte le sessioni attive)                                     |
| `WEBHOOK_SECRET`        | No                                                 | Mai (deve coincidere con il secret configurato nelle impostazioni webhook su GitHub)                   |

### Rotazione del `GITHUB_TOKEN`

Il `GITHUB_TOKEN` (Personal Access Token con scope `repo`) è l'unico secret con scadenza. Quando scade:

1. Crea un nuovo token su [GitHub Settings > Tokens](https://github.com/settings/tokens) con scope `repo`
2. Aggiorna il secret su Cloudflare:

```bash
npx wrangler secret put GITHUB_TOKEN
```

3. Incolla il nuovo token quando richiesto

Nessun altro secret o configurazione su Cloudflare deve essere aggiornato.

---

## Configurare il client MCP nel IDE

### Windsurf / Cursor

Crea o modifica il file `mcp_config.json` nel tuo IDE (in Windsurf: Settings > MCP Servers):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": [
        "workers-mcp",
        "proxy",
        "https://second-brain.<tuo-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

Sostituisci `<tuo-subdomain>` con il tuo subdomain reale.

Al primo utilizzo, il IDE aprira il browser per l'autenticazione GitHub. Dopo il login, i 3 tool (`retrieve`, `ingest`, `reindex`) saranno disponibili nell'AI assistant.

### Claude Desktop

Aggiungi al file `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": [
        "workers-mcp",
        "proxy",
        "https://second-brain.<tuo-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

---

## Sviluppo

### Comandi disponibili

| Comando                     | Descrizione                                  |
| --------------------------- | -------------------------------------------- |
| `npm run dev`               | Avvia il Worker in locale con `wrangler dev` |
| `npm run deploy`            | Deploy su Cloudflare                         |
| `npm test`                  | Esegue i test (vitest)                       |
| `npm run test:watch`        | Test in watch mode                           |
| `npm run typecheck`         | Type checking con `tsc --noEmit`             |
| `npm run db:migrate`        | Applica migration D1 in locale               |
| `npm run db:migrate:remote` | Applica migration D1 in remoto               |
| `npm run setup`             | Script di ingest della wiki                  |
| `npm run setup:dry`         | Dry run dello script di setup                |

### Struttura del progetto

```
src/
├── worker.ts          # Entry point: OAuthProvider + routing
├── mcp.ts             # SecondBrainMCP (McpAgent) con i 3 tool
├── handlers.ts        # Logica core: ingest, retrieve, reindex, health
├── chunker.ts         # Markdown chunker (split su ##/###, overlap, wikilink-safe)
├── github-handler.ts  # Hono app: REST API + OAuth flow (/authorize, /callback)
├── oauth-utils.ts     # Utility OAuth: state, CSRF, cookie, approval dialog
├── webhook.ts         # GitHub webhook handler per sync automatico
└── setup.ts           # Logica del setup script (ingest bulk)

migrations/
└── 0001_initial_schema.sql  # Schema D1: files, chunks, chunks_fts + trigger

scripts/
└── setup.ts           # CLI entry point per il setup script

test/                  # Test suite (vitest + @cloudflare/vitest-pool-workers)
```

### Test

```bash
npm test           # tutti i test
npm run typecheck  # type checking
```

I test usano `@cloudflare/vitest-pool-workers` per simulare l'ambiente Workers con D1, R2, e AI bindings.

---

## Documenti

- [PRD](.context/prd.md)
- [Architecture](.context/architecture.md)
- [UI Specification](.context/ui_specification.md)
- [Tasks](.context/tasks.md)
- [ADR-0001](docs/adr/0001-second-brain-serverless-architecture.md)

---

## Limiti e note

- Il chunker e ottimizzato per **markdown** con frontmatter YAML e wikilink `[[Nome]]` (formato Obsidian)
- L'embedding model `bge-base-en-v1.5` produce vettori a 768 dimensioni — assicurati che il Vectorize index sia creato con `--dimensions 768`
- Il retrieve ibrido usa pesi 50% semantico + 50% keyword, con top-K = 20 per ciascuna modalita
- Il content dei risultati viene troncato a 2000 caratteri per chunk
- L'OAuth flow supporta solo GitHub come identity provider
- Il webhook sync processa solo file `.md` nella cartella `wiki/` su push a `main`
