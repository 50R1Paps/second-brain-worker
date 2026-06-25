# Second Brain Worker

Cloudflare Worker che indicizza la [wiki Obsidian](https://github.com/50R1Paps/Mysecondbrain) e file esterni, con retrieve ibrido (semantico + keyword) accessibile via MCP da IDE.

## Architettura

- **R2** — storage raw dei file
- **D1** — metadata + FTS5 keyword search
- **Vectorize** — embedding semantici (bge-base-en-v1.5, 768 dim)
- **Workers AI** — generazione embedding
- **workers-mcp** — MCP remoto con OAuth GitHub

Tutto entro il free tier di Cloudflare.

## Documenti

- [PRD](.context/prd.md)
- [Architecture](.context/architecture.md)
- [UI Specification](.context/ui_specification.md)
- [Tasks](.context/tasks.md)
- [ADR-0001](docs/adr/0001-second-brain-serverless-architecture.md)

## Setup

```bash
npm install
wrangler deploy
```
