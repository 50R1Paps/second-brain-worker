# Architecture — Second Brain Serverless

**Data:** 2026-06-25  
**ADR di riferimento:** [0001-second-brain-serverless-architecture](../docs/adr/0001-second-brain-serverless-architecture.md)

---

## Diagramma

```
IDE (Windsurf) ─MCP stdio─▶ workers-mcp proxy ─HTTPS─▶ Cloudflare Worker
                                                              │
                     ┌────────────────────────────────────────┼────────────────────┐
                     ▼                     ▼                  ▼                    ▼
               Chonkie (WASM)       R2 (file raw)      D1 (metadati)       Vectorize (vettori)
               chunking markdown    + testo estratto    + chunk ref          + Workers AI (embedding)
                                                          + FTS5 index
```

## Componenti

### 1. Cloudflare Worker (`src/worker.ts`)

Entry point unico. Routing:

| Route | Metodo | Descrizione |
|-------|--------|-------------|
| `/mcp` | POST | Endpoint MCP (via workers-mcp) |
| `/api/ingest` | POST | Ingestion di un singolo file (chiamato dal setup script) |
| `/api/retrieve` | POST | Retrieve ibrido (semantico + keyword) |
| `/api/reindex` | POST | Reindex di un file o di tutti |
| `/api/health` | GET | Health check |
| `/webhook/github` | POST | GitHub webhook per sync automatico (fase 2) |

**Vincoli:** 50 subrequests/request (free plan). L'ingestion di un file richiede: 1 R2 put + 1 D1 insert + N Vectorize upsert (dove N = numero chunk). Per file > 50 chunk, il setup script chunka in lotti.

### 2. R2 — Object Storage

**Bucket:** `second-brain-raw`

Struttura chiavi:
- Wiki page: `wiki/{path_relativo}` (es. `wiki/concepts/Tool Attention.md`)
- File ingeriti: `files/{file_key}` (es. `files/paper-xyz:uuid`)

Contenuto: raw originale del file (markdown, PDF binario).

### 3. D1 — SQLite Database

**Schema:**

```sql
-- Metadata dei file indicizzati
CREATE TABLE files (
  file_key TEXT PRIMARY KEY,
  file_type TEXT NOT NULL,        -- 'wiki_page' | 'ingested'
  r2_key TEXT NOT NULL,
  title TEXT,
  source TEXT,                    -- URL o path sorgente
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0
);

-- Chunk con riferimento al file e posizione
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key TEXT NOT NULL REFERENCES files(file_key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,          -- testo del chunk
  section TEXT,                   -- titolo sezione (es. "## Architecture")
  wikilinks TEXT,                 -- JSON array di wikilink nel chunk
  vector_id TEXT,                 -- ID in Vectorize
  UNIQUE(file_key, chunk_index)
);

-- Indice full-text per keyword search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Trigger per mantenere FTS sincronizzato
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
```

### 4. Vectorize — Vector Database

**Index:** `second-brain-embeddings`  
**Modello:** bge-base-en-v1.5 (768 dimensioni, Workers AI)  
**Metadata per vector:** `{ file_key, chunk_index, section }`

### 5. Chonkie (WASM) — Chunking

Chunking rispettoso della struttura markdown:
- Split su sezioni `##` e `###`
- Frontmatter YAML preservato in ogni chunk (per contesto)
- Wikilink `[[Nome]]` non spezzati
- Chunk target: 500-1000 caratteri, overlap 50 caratteri

### 6. workers-mcp — MCP Remoto

Proxy MCP che espone il Worker come server MCP remoto:
- **Transport:** HTTPS (Streamable HTTP)
- **Auth:** OAuth Cloudflare con login GitHub
- **Tool MCP esposti:**
  - `retrieve` — ricerca ibrida nel knowledge base
  - `ingest` — caricamento di un file (fase 2)
  - `reindex` — re-indicizzazione

### 7. Setup Script (`scripts/setup.ts`)

Script locale (eseguito con `wrangler` o `tsx`) che:
1. Legge tutti i file `.md` in `wiki/`
2. Per ogni file, chiama `POST /api/ingest` con il contenuto
3. Gestisce il limite di 50 subrequests processando un file alla volta
4. Mostra progress bar

### 8. GitHub Webhook (fase 2)

- **Evento:** `push` su `main`
- **Payload:** lista file `.md` modificati in `wiki/`
- **Worker action:** per ogni file modificato, chiama `POST /api/reindex`
- **Auth:** HMAC signature verification

## Flusso Retrieve

```
1. IDE → MCP tool "retrieve" con query testuale
2. Worker riceve query
3. Worker AI genera embedding della query (bge-base-en-v1.5)
4. Query parallela:
   a. Vectorize: top-K chunk per similarità coseno
   b. D1 FTS5: top-K chunk per BM25 score
5. Merge risultati: deduplica per (file_key, chunk_index), combina score
6. Per ogni chunk: lookup D1 per metadata (section, wikilinks, file title)
7. Risposta: lista di chunk con content, file_key, section, score
```

## Flusso Ingestion

```
1. Setup script legge file da wiki/
2. POST /api/ingest { file_key, content, file_type }
3. Worker:
   a. R2 PUT: salva raw in second-brain-raw/{file_key}
   b. Chonkie: chunka il content
   c. Per ogni chunk:
      - Workers AI: genera embedding
      - Vectorize: upsert vector con metadata
      - D1: INSERT chunk + file metadata
   d. Se chunk > 50: chunka in lotti (rispetta limite subrequests)
4. Risposta: { file_key, chunk_count, status: "ok" }
```

## Configurazione (`wrangler.toml`)

```toml
name = "second-brain"
main = "src/worker.ts"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "RAW_BUCKET"
bucket_name = "second-brain-raw"

[[d1_databases]]
binding = "DB"
database_name = "second-brain"
database_id = "<da-creare>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "second-brain-embeddings"

[ai]
binding = "AI"

# MCP
[[mcp]]
binding = "MCP"
```

## Sicurezza

- **OAuth GitHub:** tramite workers-mcp, solo il proprietario del repo può accedere
- **GitHub PAT:** stored come Worker secret (`GITHUB_TOKEN`), scope `contents:read`
- **Webhook secret:** stored come Worker secret (`WEBHOOK_SECRET`), HMAC verification
- **Niente CORS pubblico:** il Worker risponde solo a richieste MCP autenticate
