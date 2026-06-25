import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/chunker";

const SAMPLE_WITH_FRONTMATTER = `---
title: Tool Attention
tags: [concept, AI]
---

# Tool Attention

## Definition

Tool Attention è il meccanismo che permette a un modello di selezionare quali strumenti utilizzare durante il ragionamento. Si basa su [[Self-Attention]] e [[Transformer]].

## Architecture

L'architettura di Tool Attention combina multi-head attention con un routing mechanism. Ogni tool ha un proprio embedding space e il modello calcola la similarità tra la query e i tool embeddings.

### Routing

Il routing usa una softmax sui similarity scores per selezionare il tool più rilevante. Questo permette al modello di scegliere tra [[Self-Attention]], [[Cross-Attention]] e altri meccanismi.

## Applications

Tool Attention è usato in sistemi come Gorilla e Toolformer per selezionare API calls appropriate. Il modello impara a mappare query naturali a tool specifici.`;

const SAMPLE_NO_FRONTMATTER = `# Test Page

## Section A

Questo è il contenuto della sezione A. Contiene un wikilink [[Example]].

## Section B

Contenuto della sezione B senza wikilink.`;

describe("chunkMarkdown", () => {
  it("extracts frontmatter and includes it in every chunk", () => {
    const chunks = chunkMarkdown(SAMPLE_WITH_FRONTMATTER);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content).toContain("title: Tool Attention");
      expect(chunk.content).toContain("---");
    }
  });

  it("splits on ## and ### headings", () => {
    const chunks = chunkMarkdown(SAMPLE_WITH_FRONTMATTER);
    const sections = chunks.map((c) => c.section);
    expect(sections).toContain("## Definition");
    expect(sections).toContain("## Architecture");
    expect(sections).toContain("### Routing");
    expect(sections).toContain("## Applications");
  });

  it("extracts wikilinks from chunk content", () => {
    const chunks = chunkMarkdown(SAMPLE_WITH_FRONTMATTER);
    const definitionChunk = chunks.find((c) => c.section === "## Definition");
    expect(definitionChunk).toBeDefined();
    expect(definitionChunk!.wikilinks).toContain("[[Self-Attention]]");
    expect(definitionChunk!.wikilinks).toContain("[[Transformer]]");
  });

  it("deduplicates wikilinks within a chunk", () => {
    const text = `---
title: Test
---

## Section

Link to [[Self-Attention]] and again [[Self-Attention]].`;
    const chunks = chunkMarkdown(text);
    const wikilinks = chunks[0].wikilinks;
    expect(wikilinks.filter((w) => w === "[[Self-Attention]]")).toHaveLength(1);
  });

  it("does not break wikilinks across chunks", () => {
    const longContent = `---
title: Test
---

## Section

${"A".repeat(400)} [[VeryLongWikilinkName]] ${"B".repeat(400)}`;
    const chunks = chunkMarkdown(longContent);
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/\[\[[^\]]*$/);
      expect(chunk.content).not.toMatch(/^[^\[]*\]\]/);
    }
  });

  it("assigns sequential chunk_index starting from 0", () => {
    const chunks = chunkMarkdown(SAMPLE_WITH_FRONTMATTER);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it("handles content without frontmatter", () => {
    const chunks = chunkMarkdown(SAMPLE_NO_FRONTMATTER);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].section).toBe("## Section A");
  });

  it("handles empty input", () => {
    const chunks = chunkMarkdown("");
    expect(chunks).toHaveLength(0);
  });

  it("respects max chunk size of 1000 chars", () => {
    const longSection = `---
title: Long
---

## Long Section

${"X".repeat(3000)}`;
    const chunks = chunkMarkdown(longSection);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1100);
    }
  });

  it("preserves heading text in section field", () => {
    const chunks = chunkMarkdown(SAMPLE_WITH_FRONTMATTER);
    const routingChunk = chunks.find((c) => c.section === "### Routing");
    expect(routingChunk).toBeDefined();
    expect(routingChunk!.content).toContain("### Routing");
  });
});
