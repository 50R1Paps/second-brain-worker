# Second Brain Serverless su Cloudflare — Architettura free-tier

Il Second Brain deve essere consultabile via MCP da IDE, indicizzare la wiki Obsidian (markdown con wikilink) e file esterni (PDF), e restare entro il free tier di Cloudflare. Abbiamo scelto: Worker con R2 (raw + testo estratto), D1 (metadata + FTS5 keyword search), Vectorize (embedding semantici con bge-base-en-v1.5), workers-mcp per MCP remoto con OAuth, GitHub webhook per sync automatico delle wiki page, script locale per setup iniziale.

## Considered Options

- **Durable Objects + Qdrant** (workerbase originale): scartato perché DO richiede paid plan per uso serio e Qdrant è un servizio esterno con latenza di rete.
- **R2 + D1 + Vectorize** (scelto): tutto nativo Cloudflare, zero latenza di rete, free tier generoso.
- **MCP locale (stdio proxy)**: scartato a favore di workers-mcp remoto per eliminare il processo locale e permettere accesso da qualsiasi dispositivo.
- **BM25 solo (Qdrant)**: scartato perché non cattura significato semantico. Scelto hybrid (Vectorize + D1 FTS5).
- **Chunking a caratteri fissi**: scartato a favore di chunking rispettoso della struttura markdown (sezioni `##`, frontmatter preservato, wikilink non spezzati).

## Consequences

- Il Worker ha un limite di 50 subrequests per richiesta (free plan). Il setup iniziale usa uno script locale che chiama il Worker per-file.
- Il repo GitHub deve essere accessibile dal Worker (PAT con `contents:read`).
- L'auth MCP usa OAuth Cloudflare (login GitHub nel browser).
- Il modello di embedding (bge-base-en-v1.5, 768 dim) è ottimizzato per inglese; l'italiano funziona ragionevolmente per termini tecnici ma potrebbe essere meno preciso per linguaggio naturale italiano.
