# Second Brain Serverless

Un knowledge base personale su Cloudflare Workers che indicizza la wiki Obsidian e file ingeriti (PDF, articoli), consultabile via MCP da IDE per supportare implementazioni tecniche.

## Language

**Second Brain**:
Il knowledge base personale dell'utente: contiene la wiki Obsidian (note markdown con wikilink e frontmatter YAML) e file ingeriti esterni (PDF, articoli). Consultabile via MCP da IDE.
_Avoid_: wiki, vault, database

**Wiki Page**:
Una nota markdown della wiki Obsidian con frontmatter YAML, wikilink `[[Nome]]`, e struttura in cartelle (`sources/`, `entities/`, `concepts/`, ecc.).
_Avoid_: note, documento, file

**Ingested File**:
Un file caricato nel Second Brain al di fuori della wiki Obsidian (PDF, articolo, testo). Ha un `file_key` univoco.
_Avoid_: documento, upload

**File Key**:
Identificatore univoco di un file nel sistema. Per le wiki page è il path relativo (es. `wiki/concepts/Tool Attention.md`). Per i file ingeriti è `filename:uuid`.
_Avoid_: id, chiave

**Chunk**:
Una sezione di testo estratta da un file, usata per l'indicizzazione. Per i markdown, rispetta la struttura delle sezioni (`##`). Contiene metadata (file_key, posizione, wikilink presenti).
_Avoid_: pezzo, frammento, slice

**Wikilink**:
Link in formato Obsidian `[[Nome Pagina]]` all'interno di una wiki page. Nei risultati di ricerca viene convertito in path relativo (es. `[[Tool Attention]]` → `wiki/concepts/Tool Attention.md`).
_Avoid_: link, collegamento

**Retrieve**:
Ricerca hybrid nel knowledge base: query semantica via Vectorize + query keyword via D1 FTS5. Ritorna chunk ordinati per rilevanza con path del file sorgente.
_Avoid_: search, query, find

**Reindex**:
Operazione di re-indicizzazione di un file o di tutti i file. Rilegge il raw da R2, re-esegue chunking + embedding, aggiorna Vectorize e D1.
_Avoid_: refresh, update, sync

**Ingestion**:
Il processo di caricamento e indicizzazione di un file: parse → chunk → embedding → Vectorize + D1 + R2 (raw).
_Avoid_: upload, import, store

**GitHub Sync**:
Meccanismo di aggiornamento automatico: un GitHub webhook notifica il Worker quando si fa push. Il Worker processa i file `.md` cambiati nella cartella `wiki/`.
_Avoid_: webhook, auto-update
