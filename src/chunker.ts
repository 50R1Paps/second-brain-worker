export interface Chunk {
  content: string;
  section: string;
  wikilinks: string[];
  chunk_index: number;
}

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n/;
const HEADING_PATTERN = /^(#{2,3})\s+(.+)$/;

const MIN_CHUNK_SIZE = 500;
const MAX_CHUNK_SIZE = 1000;
const OVERLAP = 50;

export function chunkMarkdown(text: string): Chunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const frontmatterMatch = text.match(FRONTMATTER_PATTERN);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
  const body = frontmatterMatch ? text.slice(frontmatterMatch[0].length) : text;

  const sections = splitBySections(body);
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = splitSectionIntoChunks(section.content, frontmatter);
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

interface Section {
  heading: string;
  content: string;
}

function splitBySections(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(HEADING_PATTERN);
    if (match) {
      if (
        currentHeading !== null &&
        currentLines.join("\n").trim().length > 0
      ) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n"),
        });
      }
      currentHeading = line;
      currentLines = [line];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeading !== null && currentLines.join("\n").trim().length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n"),
    });
  }

  if (sections.length === 0 && body.trim().length > 0) {
    return [{ heading: "", content: body }];
  }

  return sections;
}

function splitSectionIntoChunks(
  sectionContent: string,
  frontmatter: string,
): string[] {
  const fullContent = frontmatter + sectionContent;

  if (fullContent.length <= MAX_CHUNK_SIZE) {
    return [fullContent];
  }

  const contentLimit = Math.max(1, MAX_CHUNK_SIZE - frontmatter.length);
  return splitTextSafely(sectionContent, contentLimit).map(
    (content) => frontmatter + content,
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
