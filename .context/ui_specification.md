# UI Specification — Second Brain Serverless

**Data:** 2026-06-25

---

## Interfaccia

Il Second Brain **non ha UI web**. L'interfaccia utente è l'IDE (Windsurf) via MCP. L'utente interagisce attraverso i tool MCP esposti dal Worker.

## Tool MCP

### `retrieve`

**Descrizione:** Cerca nel knowledge base con ricerca ibrida (semantica + keyword).

**Input:**
```json
{
  "query": "string — query testuale",
  "limit": "number? — max risultati (default 10)",
  "filter": "object? — filtri opzionali"
}
```

**Filter opzionali:**
```json
{
  "file_type": "wiki_page | ingested",
  "section_prefix": "string — es. '## Architecture'",
  "file_key_prefix": "string — es. 'wiki/concepts/'"
}
```

**Output:**
```json
{
  "results": [
    {
      "file_key": "wiki/concepts/Tool Attention.md",
      "title": "Tool Attention",
      "chunk_index": 3,
      "section": "## Definition",
      "content": "Tool Attention è il meccanismo...",
      "wikilinks": ["[[Self-Attention]]", "[[Transformer]]"],
      "score": 0.87,
      "search_type": "hybrid"
    }
  ],
  "total": 42,
  "query": "tool attention definition",
  "latency_ms": 120
}
```

**Comportamento:**
- Query semantica via Vectorize (top 20)
- Query keyword via D1 FTS5 (top 20)
- Merge + deduplica + re-rank per score combinato
- Risultati ordinati per score descending
- `content` troncato a 2000 caratteri se necessario

### `ingest` (fase 2)

**Descrizione:** Carica e indicizza un file nel knowledge base.

**Input:**
```json
{
  "file_key": "string — identificatore univoco",
  "content": "string — contenuto del file",
  "file_type": "wiki_page | ingested",
  "title": "string?",
  "source": "string? — URL o path sorgente"
}
```

**Output:**
```json
{
  "file_key": "wiki/concepts/Tool Attention.md",
  "chunk_count": 5,
  "status": "ok"
}
```

### `reindex`

**Descrizione:** Re-indicizza un file o tutti i file.

**Input:**
```json
{
  "file_key": "string? — se omesso, reindex di tutti"
}
```

**Output:**
```json
{
  "reindexed": 42,
  "errors": [],
  "status": "ok"
}
```

## Configurazione MCP in Windsurf

File `mcp_config.json` (o equivalente Windsurf):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": ["workers-mcp", "proxy", "https://second-brain.<account>.workers.dev/mcp"],
      "env": {}
    }
  }
}
```

L'auth OAuth avviene al primo utilizzo: browser si apre, login GitHub, token cached.

## Endpoint HTTP diretti (per setup script e debugging)

### `POST /api/ingest`

Stesso input/output del tool MCP `ingest`. Usato dal setup script locale.

### `POST /api/retrieve`

Stesso input/output del tool MCP `retrieve`. Utile per testing con curl.

### `POST /api/reindex`

Stesso input/output del tool MCP `reindex`.

### `GET /api/health`

```json
{
  "status": "ok",
  "version": "1.0.0",
  "indexed_files": 109,
  "total_chunks": 450
}
```

### `POST /webhook/github` (fase 2)

Riceve push event da GitHub. Verifica HMAC signature. Processa file `.md` modificati.

## Errori

Tutti gli endpoint restituiscono errori in formato:

```json
{
  "error": {
    "code": "INGESTION_FAILED",
    "message": "Chunking failed: invalid markdown",
    "file_key": "wiki/concepts/Broken.md"
  }
}
```

Codici errore:
- `UNAUTHORIZED` — OAuth token mancante o invalido
- `RATE_LIMITED` — free tier limite raggiunto
- `INGESTION_FAILED` — errore durante chunking o embedding
- `RETRIEVE_FAILED` — errore durante query Vectorize o D1
- `FILE_NOT_FOUND` — file_key non esiste
- `WEBHOOK_INVALID` — HMAC signature non valida
