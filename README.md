# Second Brain Worker

Un knowledge base personale **serverless** su Cloudflare Workers che indicizza la tua [wiki Obsidian](https://github.com/50R1Paps/Mysecondbrain) e file esterni, con ricerca ibrida (semantica + keyword) accessibile via **MCP (Model Context Protocol)** direttamente dal tuo IDE.

## Cos'è

Second Brain Worker è un Cloudflare Worker che:

- **Indicizza** file markdown dalla wiki Obsidian e file esterni (PDF, articoli, testo)
- **Chunka** il contenuto rispettando la struttura delle sezioni (`##`/`###`), preservando frontmatter e wikilink
- **Genera embedding** semantici via Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dim)
- **Memorizza** tutto in R2 (raw), D1 (metadata + FTS5 keyword search), e Vectorize (embedding)
- **Espone 5 tool MCP** — `retrieve`, `ingest`, `reindex`, `read`, `grep` — accessibili dal tuo IDE via OAuth GitHub
- **Sincronizza** automaticamente la wiki via GitHub webhook: i push su `master` riconciliano i file `.md` cambiati con il contenuto corrente

Il consumo è soggetto alle quote e al piano Cloudflare: i limiti applicativi riducono gli abusi, non garantiscono costi nulli.

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
- **Durable Object** (`OWNER_MCP`, classe `OwnerMCP`) — mantiene le sole nuove sessioni MCP; il vecchio binding non viene riutilizzato
- **Durable Object** (`MUTATIONS`, classe `FileCoordinator`) — serializza ingest, delete e reindex per file
- **OAuth Provider** — integrazione `@cloudflare/workers-oauth-provider` con GitHub OAuth

---

## MCP Tools

Il server MCP espone 5 tool accessibili dal tuo IDE:

### `retrieve`

Ricerca ibrida nel knowledge base: query semantica via Vectorize + query keyword via D1 FTS5. I risultati vengono fusi (merge) con pesi 50/50, ordinati per score combinato, e arricchiti con metadata dal D1.

**Parametri:**

- `query` (string, required) — query in linguaggio naturale o keyword
- `limit` (number, default 10, max 50) — numero massimo di risultati
- `file_type` (`"wiki_page"` | `"ingested"`, optional) — filtra per tipo di file
- `section_prefix` (string, optional) — filtra per prefisso sezione (es. `## Architecture`)
- `file_key_prefix` (string, optional) — filtra per prefisso file key (es. `wiki/concepts/`)

### `ingest`

Carica un file nel knowledge base. Raw e vettori vengono preparati con identificatori versionati; metadata e chunk attivi vengono poi pubblicati atomicamente in D1. Un errore di staging mantiene la versione precedente. Vectorize è eventualmente consistente: la ricerca semantica può aggiornarsi dopo la pubblicazione.

**Parametri:**

- `file_key` (string, required) — identificatore univoco. Per wiki page: path relativo (es. `wiki/concepts/Tool Attention.md`). Per file esterni: `filename:uuid`
- `content` (string, required) — contenuto testuale completo
- `file_type` (`"wiki_page"` | `"ingested"`, required) — tipo di file
- `title` (string, optional) — titolo del file
- `source` (string, optional) — URL o path sorgente
- `push_to_github` (boolean, optional, default **false**) — solo `true` pubblica una `wiki_page` nel repository GitHub; sono ammessi esclusivamente percorsi canonici `wiki/*.md`, anche annidati

Il tipo associato a un `file_key` è stabile: un ingest con tipo diverso restituisce 409 senza sostituire il documento attivo.

### `reindex`

Re-indicizza un file specifico o tutti i file, preservando tipo, titolo e sorgente. Non scrive su GitHub. Un reindex parziale restituisce un errore con i file falliti e il conteggio completato.

**Parametri:**

- `file_key` (string, optional) — file da re-indicizzare. Se omesso, re-indicizza tutti i file

### `read`

Legge il testo raw di un file indicizzato da R2 con offset/limite opzionali. Utile per leggere il contesto completo attorno a un chunk trovato via retrieve.

**Parametri:**

- `file_key` (string, required) — file key del file da leggere
- `offset` (number, optional, default 0) — offset in caratteri da cui iniziare
- `max_chars` (number, optional, default 2000, max 10000) — numero massimo di caratteri da restituire

### `grep`

Cerca un pattern regex nel testo raw di un file indicizzato. Restituisce i match con contesto opzionale. Utile per estrarre dati strutturati (date, importi, ID) dai documenti.

**Parametri:**

- `file_key` (string, required) — file key del file in cui cercare
- `pattern` (string, required) — regex RE2, massimo 512 byte UTF-8; lookaround e backreference non sono supportati
- `max_matches` (number, optional, default 10, max 50) — numero massimo di match
- `context` (number, optional, default 40, max 200) — caratteri di contesto attorno a ogni match

---

## REST API

Oltre ai tool MCP, il Worker espone endpoint REST per script e setup. Tutti richiedono `Authorization: Bearer <API_TOKEN>`, tranne `GET /api/health` (pubblico, restituisce solo i conteggi). Senza `API_TOKEN` configurato le richieste vengono rifiutate con 401. Il webhook usa la propria firma (`WEBHOOK_SECRET`).

| Metodo | Endpoint          | Descrizione                                                       |
| ------ | ----------------- | ----------------------------------------------------------------- |
| GET    | `/api/health`     | Stato del Worker: file indicizzati, chunk totali                  |
| POST   | `/api/ingest`     | Ingest di un file (stesso formato del tool MCP)                   |
| POST   | `/api/retrieve`   | Retrieve ibrido (stesso formato del tool MCP)                     |
| POST   | `/api/reindex`    | Reindex di un file o di tutti                                     |
| POST   | `/api/read`       | Leggi raw text da R2 con offset/limit                             |
| POST   | `/api/grep`       | Ricerca regex sul contenuto indicizzato                           |
| GET    | `/api/metrics`    | Metriche aggregate di retrieve (latency, score, zero-result rate) |
| POST   | `/webhook/github` | Webhook GitHub per sync automatico                                |

---

## Prerequisiti

- **Node.js** 24+
- **Account Cloudflare** con piano e quote sufficienti per i binding configurati
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

Per un fork, aggiorna anche l'ID GitHub proprietario in `src/authorization.ts`, ID/nome del repository nel webhook e l'URL canonico `resourceMetadata.resource` in `src/worker.ts`. Questi sono confini di autorizzazione, non valori ricavati dal client.

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

# REST API (/api/*): token bearer, es. `openssl rand -hex 32`
npx wrangler secret put API_TOKEN

# GitHub webhook sync (opzionale, solo se usi il sync automatico)
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_TOKEN_EXPIRY
```

Per `COOKIE_ENCRYPTION_KEY` puoi generare una stringa casuale con:

```bash
openssl rand -hex 32
```

Per `GITHUB_TOKEN`, preferisci un PAT fine-grained limitato ai repository necessari: Contents read/write sulla wiki per sync/pubblicazione e Issues read/write sul repository del Worker per il promemoria. Evita un token classic con accesso indiscriminato ai repository privati. Il token OAuth usato per identificare l'utente non viene conservato e non sostituisce questo secret server-side.

Per `WEBHOOK_SECRET`, genera un'altra stringa casuale e usala anche come secret del webhook GitHub.

Per `GITHUB_TOKEN_EXPIRY`, inserisci la data di scadenza del PAT in formato ISO (es. `2026-09-25T00:00:00Z`). Il Cron Trigger giornaliero controlla questa data e apre automaticamente una issue su [second-brain-worker](https://github.com/50R1Paps/second-brain-worker/issues) 2 giorni prima della scadenza come promemoria.

### 7. Deploy

```bash
npm run deploy
```

Annota l'URL del Worker (es. `https://second-brain.<tuo-subdomain>.workers.dev`).

### 8. Inizializza il knowledge base (setup script)

Se hai la wiki Obsidian in locale, puoi ingerire tutti i file `.md` con lo script di setup:

```bash
# Il token REST va passato via env
export SECOND_BRAIN_API_TOKEN=<API_TOKEN>

# Locale (durante dev)
npm run setup -- --publish --wiki-dir /path/to/wiki --url http://localhost:8787

# Remoto (dopo deploy)
npm run setup -- --publish --wiki-dir /path/to/wiki --url https://second-brain.<tuo-subdomain>.workers.dev

# Dry run (lista file senza ingerire)
npm run setup:dry -- --wiki-dir /path/to/wiki
```

Senza `--publish` lo script esegue solo una scansione locale. Qui `--publish` significa inviare al Worker, non scrivere su GitHub. La scansione rifiuta symlink/junction, uscite dalla radice, file oltre 256 KiB e oltre 1000 file.

### 9. Configura il webhook GitHub (opzionale)

Per sincronizzare automaticamente la wiki quando fai push su `master`:

1. Vai su [GitHub > Your Repo > Settings > Webhooks > Add webhook](https://github.com/50R1Paps/Mysecondbrain/settings/hooks/new)
2. Compila:
   - **Payload URL:** `https://second-brain.<tuo-subdomain>.workers.dev/webhook/github`
   - **Content type:** `application/json`
   - **Secret:** lo stesso valore di `WEBHOOK_SECRET`
   - **Trigger:** "Just the push event"
3. Salva

Da ora, ogni push su `master` che modifica file `.md` in `wiki/` riconcilia l'indice. Sono accettati solo repository ID `1270260749` e nome `50R1Paps/Mysecondbrain`, con firma HMAC valida. I replay dello stesso corpo vengono deduplicati per 7 giorni. Un evento di rimozione elimina dall'indice solo dopo un 404 sul contenuto corrente; errori GitHub di autenticazione o servizio non autorizzano cancellazioni.

---

## Gestione dei secret

I secret sono gestiti via `wrangler secret put` e stored nella dashboard Cloudflare (mai nel codice). Ecco quando aggiornarli:

| Secret                  | Scade?                                             | Quando aggiornare                                                                                           |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`          | **Sì** — scade in base alla configurazione del PAT | Quando il Personal Access Token scade: `npx wrangler secret put GITHUB_TOKEN` e incolla il nuovo token      |
| `GITHUB_TOKEN_EXPIRY`   | **Sì** — da aggiornare insieme al token            | Quando aggiorni `GITHUB_TOKEN`: `npx wrangler secret put GITHUB_TOKEN_EXPIRY` con la nuova data di scadenza |
| `GITHUB_CLIENT_ID`      | No                                                 | Solo se revochi/ricrei l'OAuth App su GitHub                                                                |
| `GITHUB_CLIENT_SECRET`  | No                                                 | Solo se revochi/ricrei l'OAuth App su GitHub                                                                |
| `COOKIE_ENCRYPTION_KEY` | No                                                 | Mai (a meno che tu non voglia invalidare tutte le sessioni attive)                                          |
| `WEBHOOK_SECRET`        | No                                                 | Mai (deve coincidere con il secret configurato nelle impostazioni webhook su GitHub)                        |

### Rotazione del `GITHUB_TOKEN`

Il PAT `GITHUB_TOKEN` ha una scadenza configurata. Il Cron Trigger giornaliero controlla `GITHUB_TOKEN_EXPIRY` e apre una issue su [second-brain-worker](https://github.com/50R1Paps/second-brain-worker/issues) 2 giorni prima della scadenza. La stessa esecuzione avvia separatamente la manutenzione dei dati.

Quando ricevi la notifica (o quando il token è già scaduto):

1. Crea un nuovo PAT fine-grained con i soli repository e permessi descritti nel setup
2. Aggiorna i secret su Cloudflare:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_TOKEN_EXPIRY
```

3. Incolla il nuovo token e la nuova data di scadenza (formato ISO, es. `2026-09-25T00:00:00Z`)
4. Chiudi la issue di promemoria su GitHub

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

Al primo utilizzo, il IDE aprira il browser per l'autenticazione GitHub. Dopo il login, i 5 tool (`retrieve`, `ingest`, `reindex`, `read`, `grep`) saranno disponibili nell'AI assistant.

Il servizio è privato: è autorizzato solo l'ID GitHub immutabile **57759605**, non il nome utente. Le credenziali persistono soltanto `{ githubId }`, senza token GitHub, email o nome. Token e refresh grant precedenti privi dell'ID vengono rifiutati: dopo il cutover occorre ricollegare il client. Il flusso richiede PKCE S256; i redirect devono essere HTTPS oppure HTTP su loopback locale, senza credenziali o frammenti. La REST API usa un bearer separato.

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

## Limiti e conservazione

- Ingress: 20 richieste OAuth/minuto per IP e 120 richieste/minuto sulle altre rotte, con ulteriore limite per il principal autenticato. I limiti nativi sono approssimativi per location Cloudflare. La registrazione dinamica rimane pubblica, con budget globale di 100 tentativi al giorno UTC.
- Body massimo 1 MiB, endpoint OAuth 16 KiB; file 256 KiB, frontmatter 8 KiB, massimo 512 chunk. I limiti contano i byte UTF-8 effettivamente letti, non soltanto `Content-Length`. Body compressi non ammessi.
- Le metriche non conservano il testo delle query e scadono dopo 30 giorni. Contatori e ricevute webhook scaduti vengono eliminati dal cron.
- Vecchi raw/vettori e staging falliti vengono raccolti dopo almeno 24 ore, solo se non più referenziati da D1. R2 deve restare privato.
- Preview URL e invocation logging sono disabilitati. Non aggiungere token, body, query o URL OAuth ai log. I tool MCP di lettura marcano il contenuto delle fonti come dato non attendibile, non istruzioni.

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
├── mcp.ts             # OwnerMCP (McpAgent) con i 5 tool
├── types.ts           # Tipi condivisi: Env, request/response interfaces
├── http.ts            # Utility HTTP: jsonResponse, handleCORS
├── health.ts          # Health check endpoint
├── ingest.ts          # Ingestion: chunking, embedding, R2+D1+Vectorize, GitHub push
├── file-coordinator.ts # Serializzazione delle mutazioni per file
├── storage.ts         # Garbage collection differita di raw e vettori
├── request-security.ts # Limiti ingress, body e budget di registrazione
├── retrieve.ts        # Retrieve ibrido: semantic + keyword search, merge, metrics
├── metrics.ts         # Metriche aggregate di retrieve (latency, score, zero-result)
├── reindex.ts         # Reindex singolo file o tutti i file
├── read.ts            # Read raw text da R2 con offset/limit
├── grep.ts            # Grep regex sul contenuto indicizzato
├── chunker.ts         # Markdown chunker (split su ##/###, overlap, wikilink-safe)
├── github-handler.ts  # Hono app: REST API + OAuth flow (/authorize, /callback)
├── oauth-utils.ts     # Utility OAuth: state, CSRF, cookie, approval dialog
├── webhook.ts         # GitHub webhook handler per sync automatico
├── cron.ts            # Retention, garbage collection e reminder scadenza PAT
└── setup.ts           # Logica del setup script (ingest bulk)

migrations/
├── 0001_initial_schema.sql       # Schema D1: files, chunks, chunks_fts + trigger
├── 0002_retrieve_metrics.sql     # Metriche aggregate di retrieve
├── 0003_security_controls.sql    # Budget, ricevute webhook e redazione query
└── 0004_storage_versions.sql     # Coda garbage collection differita

scripts/
└── setup.ts           # CLI entry point per il setup script

test/                  # Test suite (Vitest 4 + @cloudflare/vitest-plugin)
```

### Test

```bash
npm test           # tutti i test
npm run typecheck  # type checking
```

I test usano `@cloudflare/vitest-plugin` con Vitest 4 e il runtime Workers. `test/wrangler.test.toml` resta separato dai secret di produzione; ogni scenario azzera i binding e applica le migration reali.

---

## Operazioni di manutenzione

### Deploy del Worker

Dopo aver modificato il codice:

```bash
npm run typecheck   # verifica tipi
npm test            # verifica test
npx wrangler deploy # deploy su Cloudflare
```

Non serve reindicizzare dopo un deploy che non cambia la logica di ingest/retrieve.

### Applicare una nuova migration D1

Quando aggiungi una migration (es. `0002_retrieve_metrics.sql`):

```bash
# Locale (per dev)
npm run db:migrate

# Remoto (per produzione)
npx wrangler d1 migrations apply second-brain --remote
```

La migration va applicata **prima** del deploy se il codice dipende dalla nuova tabella.

### Cutover sicurezza e storage versionato

Prima del cutover iniziale, registra un bookmark D1 con `npx wrangler d1 time-travel info second-brain --json`. Applica le migration 0003/0004 prima del deploy.

La migration Durable Object `v2-security-cutover` crea `OwnerMCP` e `FileCoordinator` ed elimina definitivamente il vecchio namespace `SecondBrainMCP`, che può contenere props OAuth precedenti. Durante questa sola migrazione, elimina anche i vecchi record del namespace dedicato `OAUTH_KV` prima di ricollegare i client. Questa pulizia invalida credenziali e sessioni, non cancella documenti o indice. Non ripristinare vecchi grant.

Reindicizza poi i file esistenti per migrare raw e vettori al namespace versionato, senza write-back GitHub. I puntatori legacy restano leggibili fino alla pubblicazione della nuova versione; non eliminare manualmente gli oggetti precedenti. Confronta i conteggi D1 prima e dopo e verifica una lettura autenticata.

### Reindicizzare i documenti (popolare Vectorize)

Se i vettori sono mancanti o vuoi rigenerare gli embeddings:

```bash
# Reindex di un singolo file
curl -X POST https://second-brain.<tuo-subdomain>.workers.dev/api/reindex \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" \
  -d '{"file_key": "wiki/concepts/Esempio.md"}'

# Reindex di tutti i file (attenzione: può hit rate limit su Workers AI)
curl -X POST https://second-brain.<tuo-subdomain>.workers.dev/api/reindex \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" \
  -d '{}'
```

**Nota:** Workers AI e i limiti del piano possono far fallire un reindex completo. La risposta segnala i fallimenti; per migrazioni controllate usa un file per richiesta con una pausa di circa un secondo.

```bash
npx wrangler d1 execute second-brain --remote \
  --command "SELECT COUNT(*) as total, COUNT(vector_id) as with_vectors FROM chunks"
```

### Verificare le metriche di retrieve

Dopo aver fatto qualche retrieve, controlla le metriche aggregate:

```bash
# Ultime 24 ore (default)
curl -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" https://second-brain.<tuo-subdomain>.workers.dev/api/metrics

# Ultima ora
curl -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" https://second-brain.<tuo-subdomain>.workers.dev/api/metrics?period=1h

# Ultimi 7 giorni
curl -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" https://second-brain.<tuo-subdomain>.workers.dev/api/metrics?period=7d

# Ultimi 30 giorni
curl -H "Authorization: Bearer $SECOND_BRAIN_API_TOKEN" https://second-brain.<tuo-subdomain>.workers.dev/api/metrics?period=30d
```

Periodi validi: `1h`, `24h`, `7d`, `30d`.

Le metriche includono: total queries, zero-result rate, avg/p50/p95 latency,
score distribution, e search type breakdown (semantic/keyword/hybrid).

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
- Il webhook sync processa solo file `.md` nella cartella `wiki/` su push a `master`, per il repository autorizzato
- I commit automatici del Worker su GitHub includono `[skip ci]` per non triggerare la pipeline di lint
- Le metriche di retrieve sono best-effort: se la persistenza su D1 fallisce, il retrieve non viene interrotto
