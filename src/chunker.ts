export interface Chunk {
  content: string;
  section: string;
  wikilinks: string[];
  chunk_index: number;
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const TITLE_PATTERN = /^title:[ \t]*(.+?)[ \t]*$/m;
const H1_PATTERN = /^#\s+(.+)$/;
const HEADING_PATTERN = /^(#{2,3})\s+(.+)$/;
const LINK_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\[\[[^\]]+\]\]/;
const RULE_PATTERN = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const MIN_CHUNK_SIZE = 500;
const MAX_CHUNK_SIZE = 1000;
const OVERLAP = 50;

/**
 * Splits a markdown page into chunks on `##`/`###` headings. The text before
 * the first `##` is its own section, named after the H1. Each chunk starts
 * with the page title instead of the whole frontmatter, so tags and sources
 * do not inflate keyword matches in every chunk. Sections made only of
 * wikilink list items ("Vedi anche", "Collegamenti") are left out, unless
 * the page has nothing else.
 */
export function chunkMarkdown(text: string): Chunk[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.trim().length === 0) {
    return [];
  }

  const frontmatterMatch = normalized.match(FRONTMATTER_PATTERN);
  const body = frontmatterMatch
    ? normalized.slice(frontmatterMatch[0].length)
    : normalized;

  const sections = splitBySections(body);
  const contentSections = sections.filter((s) => !isLinkOnly(s.content));
  const kept = contentSections.length > 0 ? contentSections : sections;

  const title = pageTitle(frontmatterMatch?.[1], body);
  const prefix = title ? `${title}\n\n` : "";
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of kept) {
    const sectionChunks = splitSectionIntoChunks(section.content, prefix);
    for (const content of sectionChunks) {
      chunks.push({
        content,
        section: section.heading,
        wikilinks: extractWikilinks(content),
        chunk_index: chunkIndex++,
      });
    }
  }

  return chunks;
}

function pageTitle(frontmatter: string | undefined, body: string): string {
  const fromFrontmatter = frontmatter?.match(TITLE_PATTERN)?.[1];
  if (fromFrontmatter) {
    return fromFrontmatter.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  for (const line of body.split("\n")) {
    const match = line.match(H1_PATTERN);
    if (match) {
      return match[1].trim();
    }
  }
  return "";
}

/** True when every non-blank line after the heading is a wikilink list item. */
function isLinkOnly(sectionContent: string): boolean {
  const lines = sectionContent
    .split("\n")
    .filter((line) => line.trim().length > 0 && !RULE_PATTERN.test(line));
  const items = HEADING_PATTERN.test(lines[0] ?? "") ? lines.slice(1) : lines;
  return items.length > 0 && items.every((line) => LINK_ITEM_PATTERN.test(line));
}

interface Section {
  heading: string;
  content: string;
}

function splitBySections(body: string): Section[] {
  const sections: Section[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];
  let hasContent = false;

  const flush = () => {
    if (hasContent) {
      sections.push({ heading: currentHeading, content: currentLines.join("\n") });
    }
  };

  for (const line of body.split("\n")) {
    if (HEADING_PATTERN.test(line)) {
      flush();
      currentHeading = line;
      currentLines = [line];
      hasContent = false;
      continue;
    }
    if (sections.length === 0 && currentHeading === "" && H1_PATTERN.test(line)) {
      currentHeading = line;
      currentLines.push(line);
      continue;
    }
    currentLines.push(line);
    if (line.trim().length > 0 && !RULE_PATTERN.test(line)) {
      hasContent = true;
    }
  }
  flush();

  if (sections.length === 0 && body.trim().length > 0) {
    return [{ heading: currentHeading, content: body }];
  }

  return sections;
}

function splitSectionIntoChunks(
  sectionContent: string,
  prefix: string,
): string[] {
  const fullContent = prefix + sectionContent.trim();

  if (fullContent.length <= MAX_CHUNK_SIZE) {
    return [fullContent];
  }

  const contentLimit = Math.max(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE - prefix.length);
  return splitTextSafely(sectionContent, contentLimit).map(
    (content) => prefix + content,
  );
}

function splitTextSafely(text: string, limit: number): string[] {
  const wikilinkRanges = getWikilinkRanges(text);
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + limit);

    if (end < text.length) {
      end = findSafeEnd(text, start, end, wikilinkRanges);
    }

    if (end <= start) {
      end = Math.min(text.length, start + limit);
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    let nextStart = Math.max(0, end - OVERLAP);
    nextStart = adjustStartOutsideWikilink(nextStart, wikilinkRanges);

    if (nextStart <= start) {
      nextStart = end;
    }

    start = nextStart;
  }

  return chunks;
}

interface WikilinkRange {
  start: number;
  end: number;
}

function getWikilinkRanges(text: string): WikilinkRange[] {
  const ranges: WikilinkRange[] = [];
  const matches = text.matchAll(WIKILINK_PATTERN);
  for (const match of matches) {
    if (match.index !== undefined) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function findSafeEnd(
  text: string,
  start: number,
  preferredEnd: number,
  wikilinkRanges: WikilinkRange[],
): number {
  let end = adjustEndOutsideWikilink(preferredEnd, wikilinkRanges);
  const boundary = findLastBoundary(text, start, end, wikilinkRanges);

  if (boundary > start) {
    end = boundary;
  }

  return end;
}

function adjustEndOutsideWikilink(
  end: number,
  wikilinkRanges: WikilinkRange[],
): number {
  for (const range of wikilinkRanges) {
    if (end > range.start && end < range.end) {
      return range.start;
    }
  }
  return end;
}

function adjustStartOutsideWikilink(
  start: number,
  wikilinkRanges: WikilinkRange[],
): number {
  for (const range of wikilinkRanges) {
    if (start > range.start && start < range.end) {
      return range.start;
    }
  }
  return start;
}

function findLastBoundary(
  text: string,
  start: number,
  end: number,
  wikilinkRanges: WikilinkRange[],
): number {
  const minBoundary = Math.min(start + MIN_CHUNK_SIZE, end);

  for (let index = end; index > minBoundary; index--) {
    if (
      /\s/.test(text[index - 1]) &&
      !isInsideWikilink(index, wikilinkRanges)
    ) {
      return index;
    }
  }

  return end;
}

function isInsideWikilink(
  index: number,
  wikilinkRanges: WikilinkRange[],
): boolean {
  return wikilinkRanges.some(
    (range) => index > range.start && index < range.end,
  );
}

function extractWikilinks(text: string): string[] {
  const matches = text.matchAll(WIKILINK_PATTERN);
  const wikilinks: string[] = [];
  for (const match of matches) {
    wikilinks.push(match[0]);
  }
  return [...new Set(wikilinks)];
}
