# Tasks — Second Brain Serverless

**Data:** 2026-06-25  
**Metodologia:** Tracer bullet verticale — ogni task produce un slice funzionante end-to-end.

---

## Fase 1 — MVP

### Tracer Bullet 1: Worker skeleton + health check

- [ ] Inizializzare progetto: `npm create cloudflare@latest second-brain -- --type worker`
- [ ] Configurare `wrangler.toml` con bindings R2, D1, Vectorize, AI
- [ ] Implementare `GET /api/health` con conteggio file da D1
- [ ] Test: `curl https://second-brain.<account>.workers.dev/api/health`
- [ ] Deploy: `wrangler deploy`

### Tracer Bullet 2: D1 schema + chunking

- [ ] Creare migration D1 con schema completo (tables, FTS5, triggers)
- [ ] Eseguire `wrangler d1 migrations apply`
- [ ] Implementare chunking markdown con Chonkie WASM:
  - Split su `##` / `###`
  - Preservare frontmatter in ogni chunk
  - Non spezzare wikilink
  - Target 500-1000 char, overlap 50
- [ ] Test unitari sul chunker (file di esempio della wiki)

### Tracer Bullet 3: Ingestion endpoint

- [ ] Implementare `POST /api/ingest`:
  - R2 PUT raw
  - Chunking
  - Workers AI embedding per chunk
  - Vectorize upsert
  - D1 INSERT file + chunks
- [ ] Gestire limite 50 subrequests (batch di chunk)
- [ ] Test: ingest di un file reale della wiki
- [ ] Verificare: R2 ha il raw, D1 ha i chunk, Vectorize ha i vettori

### Tracer Bullet 4: Retrieve endpoint

- [ ] Implementare `POST /api/retrieve`:
  - Workers AI embedding della query
  - Vectorize query (top 20)
  - D1 FTS5 query (top 20)
  - Merge + deduplica + rank
  - Lookup metadata D1
- [ ] Test: retrieve su query nota, verificare rilevanza risultati
- [ ] Benchmark latenza (target < 500ms p95)

### Tracer Bullet 5: Setup script

- [ ] Creare `scripts/setup.ts`:
  - Scan ricorsivo `wiki/**/*.md`
  - Per ogni file: `POST /api/ingest`
  - Progress bar
  - Gestione errori + retry
- [ ] Eseguire setup su tutti i 109 file della wiki
- [ ] Verificare `GET /api/health` mostra conteggio corretto

### Tracer Bullet 6: MCP remoto

- [ ] Installare `workers-mcp` e configurare binding
- [ ] Definire tool MCP: `retrieve`, `ingest`, `reindex`
- [ ] Configurare OAuth GitHub
- [ ] Aggiungere `mcp_config.json` per Windsurf
- [ ] Test end-to-end: da Windsurf, chiamare `retrieve` via MCP
- [ ] **Goal: interrogare la wiki dall'IDE**

## Fase 2 — Automazione

### GitHub Webhook

- [ ] Implementare `POST /webhook/github`:
  - HMAC verification
  - Parse push event
  - Identificare file `.md` modificati in `wiki/`
  - Per ogni file: fetch contenuto via GitHub API + `POST /api/reindex`
- [ ] Configurare webhook su GitHub repo
- [ ] Test: push di una modifica, verificare reindex automatico

### Ingestion PDF (posticipato)

- [ ] Valutare librerie TS per estrazione testo PDF
- [ ] Implementare parser PDF in ingestion
- [ ] Test su PDF di esempio

## Fase 3 — Affinamento

### Re-ranking

- [ ] Implementare re-ranking dei risultati (es. reciprocal rank fusion)
- [ ] Test A/B: rilevanza con vs senza re-ranking

### Chunking avanzato

- [ ] Valutare chunking semantico (sentenze invece di sezioni)
- [ ] Metadata aggiuntivi: tag frontmatter, type di pagina

### Metriche

- [ ] Dashboard metriche: latenza p50/p95/p99, hit rate, query volume
- [ ] Logging strutturato su Workers Analytics

---

## Dipendenze

| Package | Versione | Scopo |
|---------|----------|-------|
| `wrangler` | latest | Cloudflare CLI |
| `workers-mcp` | latest | MCP remoto |
| `@anthropic-ai/sdk` | latest | MCP types (se necessario) |
| `chonkie` | latest | Chunking WASM |

## Note

- Ogni tracer bullet è indipendentemente deployable e testabile
- Il primo goal è il Tracer Bullet 6: interrogare la wiki dall'IDE
- Usare TDD per ogni componente (vedi skill `/tdd`)
