interface ParsedBlock {
  text: string;
  startLine: number; // inclusive
  endLine: number; // exclusive
}

/** Parse markdown into non-empty logical blocks with line boundaries. */
function parseBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  const push = (start: number, end: number) => {
    blocks.push({ text: lines.slice(start, end).join("\n"), startLine: start, endLine: end });
  };

  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }

    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    const fenceMatch = trimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const start = i;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    // Display math block
    if (trimmed === "$$") {
      const start = i;
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") i++;
      if (i < lines.length) i++;
      push(start, i);
      continue;
    }

    // Heading / HR
    if (/^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      push(i, i + 1);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const start = i;
      while (i < lines.length && lines[i].startsWith(">")) i++;
      push(start, i);
      continue;
    }

    // Table
    if (/^\s*\|/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      push(start, i);
      continue;
    }

    // List
    if (/^(\s*[-*+]\s|\s*\d+[.)]\s)/.test(line)) {
      const start = i;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          const next = i + 1;
          if (next < lines.length && /^(\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[next])) {
            i++;
            continue;
          }
          break;
        }
        if (/^(#{1,6}\s|```|~~~|>)/.test(l) || l.trim() === "$$") break;
        i++;
      }
      push(start, i);
      continue;
    }

    // Paragraph
    const start = i;
    while (i < lines.length && lines[i].trim() !== "") {
      const l = lines[i];
      if (/^(#{1,6}\s|```|~~~|>)/.test(l)) break;
      if (l.trim() === "$$") break;
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l.trim())) break;
      i++;
    }
    if (i > start) push(start, i);
  }

  return blocks;
}

/**
 * Measure the textarea scrollTop offset where each block begins.
 * Uses a hidden clone textarea to get accurate pixel positions.
 *
 * The measurement loop is split into chunks that yield to the main thread
 * via setTimeout(0), so large documents don't freeze the UI during note switch.
 * Pass an AbortSignal to cancel an in-progress measurement (e.g. when the
 * user switches notes before the previous measurement finishes).
 */
export async function measureBlockOffsets(
  content: string,
  sourceTextarea: HTMLTextAreaElement,
  signal?: AbortSignal,
): Promise<number[]> {
  const blocks = parseBlocks(content);
  if (blocks.length === 0) return [];

  const style = getComputedStyle(sourceTextarea);
  const totalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);

  const measure = document.createElement("textarea");
  measure.style.cssText = `
    position: fixed; top: -9999px; left: -9999px; visibility: hidden;
    width: ${style.width};
    height: auto;
    font: ${style.font};
    font-size: ${style.fontSize};
    font-family: ${style.fontFamily};
    font-weight: ${style.fontWeight};
    line-height: ${style.lineHeight};
    letter-spacing: ${style.letterSpacing};
    word-spacing: ${style.wordSpacing};
    white-space: ${style.whiteSpace};
    word-wrap: ${style.wordWrap};
    word-break: ${style.wordBreak};
    tab-size: ${style.tabSize};
    padding: ${style.padding};
    border: ${style.border};
    box-sizing: ${style.boxSizing};
    overflow: hidden;
  `;
  document.body.appendChild(measure);

  // Pre-compute line-end character positions to avoid split+slice+join per block.
  const lineEnds: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineEnds.push(i);
  }
  lineEnds.push(content.length);

  const offsets: number[] = [0];
  const total = blocks.length - 1;
  const CHUNK = 8; // yield every 8 reflows (~2–4ms) to keep UI responsive

  for (let i = 0; i < total; i++) {
    const endLine = blocks[i].endLine;
    const endPos = endLine > 0 ? lineEnds[endLine - 1] : 0;
    measure.value = endPos > 0 ? content.slice(0, endPos) : "";
    offsets.push(measure.scrollHeight - totalPadding);

    if ((i + 1) % CHUNK === 0 && i < total - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) {
        document.body.removeChild(measure);
        return offsets; // partial result, caller will discard
      }
    }
  }

  document.body.removeChild(measure);
  return offsets;
}

/** Find which block index occupies the given textarea scrollTop. */
export function blockIndexAtOffset(offsets: number[], scrollTop: number): number {
  for (let i = offsets.length - 1; i >= 0; i--) {
    if (offsets[i] <= scrollTop) return i;
  }
  return 0;
}

/**
 * Add data-block-index attributes to block-level children
 * of the MarkdownPreview root element (.font-body).
 * Indices match the non-empty block indices from parseBlocks.
 */
export function tagPreviewBlocks(container: HTMLElement): void {
  const root = container.querySelector<HTMLElement>(".font-body");
  if (!root) return;
  let index = 0;
  for (const child of root.children) {
    if (child instanceof HTMLElement) {
      child.setAttribute("data-block-index", String(index++));
    }
  }
}
