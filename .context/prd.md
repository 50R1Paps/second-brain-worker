# PRD — Second Brain Serverless

**Data:** 2026-06-25  
**Stato:** Approvato  
**ADR di riferimento:** [0001-second-brain-serverless-architecture](../docs/adr/0001-second-brain-serverless-architecture.md)

---

## Problema

Il Second Brain (wiki Obsidian in questo repo) è consultabile solo aprendo i file in Obsidian. Durante le sessioni di coding, l'utente non ha modo di interrogare la knowledge base dall'IDE per recuperare concetti, confronti o analisi già documentate.

## Soluzione

Un knowledge base serverless su Cloudflare Workers che indicizza la wiki Obsidian e file esterni (PDF, articoli), consultabile via MCP da IDE. Tutto entro il free tier di Cloudflare.

## Obiettivi

1. **Retrieve ibrido** — ricerca semantica (Vectorize) + keyword (D1 FTS5) sui contenuti della wiki
2. **Ingestion automatica** — GitHub webhook re-indicizza le wiki page modificate al push
3. **Setup iniziale** — script locale che indicizza tutti i file esistenti al primo deploy
4. **Accesso via MCP** — workers-mcp remoto con OAuth GitHub, nessun processo locale
5. **Zero costo** — tutto entro il free tier Cloudflare

## Non-obiettivi (fase 1)

- Indicizzazione di file non markdown (PDF) — posticipato alla fase 2
- UI web di ricerca — l'interfaccia è l'IDE via MCP
- Multi-utente — è un sistema personale
- Autenticazione diversa da OAuth GitHub

## Stakeholder

- **Utente:** proprietario della wiki, usa Windsurf come IDE principale
- **Consumer MCP:** qualsiasi IDE compatibile con MCP (Windsurf, Cursor, VS Code)

## Metriche di successo

| Metrica | Target |
|---------|--------|
| Latenza retrieve | < 500ms (p95) |
| Copertura indicizzazione | 100% file `.md` in `wiki/` |
| Costo mensile | $0 (free tier) |
| Setup iniziale | < 30 min per repo esistente |

## vincoli

- **Free tier Cloudflare:** Workers (100k req/giorno), R2 (10 GB), D1 (5 GB), Vectorize (30M dim)
- **50 subrequests/request** (limite Workers free plan)
- **Embedding model:** bge-base-en-v1.5 (768 dim, ottimizzato inglese, italiano accettabile per termini tecnici)
- **Repo GitHub:** PAT con `contents:read` per il Worker

## Fasi

### Fase 1 — MVP (tracer bullet)
Worker con retrieve ibrido su wiki page già indicizzate via script locale. MCP remoto con OAuth.

### Fase 2 — Automazione
GitHub webhook per sync automatico. Ingestion di PDF.

### Fase 3 — Affinamento
Re-ranking risultati, chunking avanzato, metriche di qualità retrieve.
