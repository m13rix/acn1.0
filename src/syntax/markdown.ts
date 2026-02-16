import { BaseSyntax, registerSyntax } from './base.js';

export class MarkdownSyntax extends BaseSyntax {
  name = 'markdown';

  extractBlock(text: string, identifier: string, requireClosed = false): string | null {
    const blocks = this.getAllBlocks(text);
    // Find the LAST block with this identifier
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (!block) continue; // Safety check
      if (block.lang.toLowerCase() === identifier.toLowerCase()) {
        if (requireClosed && !block.closed) {
          continue; // Skip unclosed blocks if closure is required
        }
        return block.content;
      }
    }
    return null;
  }

  /**
   * Check if code seems syntactically complete (heuristic).
   * Used to accept unclosed blocks that are likely valid (EOF).
   */
  private isCodeComplete(code: string): boolean {
    const trimmed = code.trim();
    // Common endings for valid JS/TS statements
    return trimmed.endsWith('}') || trimmed.endsWith(';') || trimmed.endsWith(')');
  }

  getThinking(text: string): string | null {
    // Thinking can be partial
    const block = this.extractBlock(text, 'think') || this.extractBlock(text, 'thought');
    if (block) return block;

    // Fallback to XML style for thought if mixed
    const xmlMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
    return xmlMatch ? xmlMatch[1].trim() : null;
  }

  getAction(text: string): string | null {
    // 1. Try strict extraction (best)
    const strict = this.extractBlock(text, 'action', true);
    if (strict) return strict;

    // 2. Try lenient extraction with completeness check
    const lenient = this.extractBlock(text, 'action', false);
    if (lenient && this.isCodeComplete(lenient)) {
      return lenient;
    }

    return null;
  }

  getObservation(text: string): string | null {
    return this.extractBlock(text, 'observation');
  }

  getCli(text: string): string | null {
    // CLI commands are simple, accept even unclosed blocks
    // Strict first for performance, then lenient fallback
    return this.extractBlock(text, 'cli', true) || this.extractBlock(text, 'cli', false);
  }

  getSkills(text: string): string | null {
    return this.extractBlock(text, 'skills');
  }

  getFiles(text: string): { path: string; content: string }[] {
    const allBlocks = this.getAllBlocks(text);
    const files: { path: string; content: string }[] = [];

    for (const block of allBlocks) {
      // strict: files must be closed to avoid partial writes that corrupt data
      if (this.isFilePath(block.lang) && block.closed) {
        files.push({
          path: block.lang,
          content: block.content
        });
      }
    }
    return files;
  }

  getDiffs(text: string): string[] {
    const allBlocks = this.getAllBlocks(text);
    const diffs: string[] = [];
    for (const block of allBlocks) {
      // strict: diffs must be closed to ensure integrity
      if (block.lang.toLowerCase() === 'diff' && block.closed) {
        diffs.push(block.content);
      }
    }
    return diffs;
  }

  /**
   * Extract edit blocks for Search & Replace format
   */
  getEdits(text: string): { filename: string; content: string }[] {
    const allBlocks = this.getAllBlocks(text);
    const edits: { filename: string; content: string }[] = [];

    for (const block of allBlocks) {
      // Check if lang starts with "edit " followed by filename
      if (block.lang.toLowerCase().startsWith('edit ')) {
        const isComplete = block.closed || this.isCodeComplete(block.content);

        // Strict-ish: Must be closed OR syntactically complete
        if (!isComplete) continue;

        const filename = block.lang.substring(5).trim();
        if (filename) {
          edits.push({
            filename,
            content: block.content
          });
        }
      }
    }
    return edits;
  }

  hasAction(text: string): boolean {
    return !!this.getAction(text);
  }

  hasCli(text: string): boolean {
    return !!this.getCli(text);
  }

  isActionClosed(text: string): boolean {
    return this.hasAnyClosedBlock(text, ['action']);
  }

  isCliClosed(text: string): boolean {
    return this.hasAnyClosedBlock(text, ['cli']);
  }

  /**
   * Checks if there are any *strictly closed* blocks of specific types (or actionable types if not specified).
   * This is used for streaming interruption.
   */
  hasAnyClosedBlock(text: string, specificLangs?: string[]): boolean {
    const regex = /(^|\r?\n)([ \t]*)(`{3,})/g;
    let match;

    let currentBlock: { start: number; lang: string; depth: number; fenceLength: number } | null = null;

    while ((match = regex.exec(text)) !== null) {
      const matchIndex = match.index;
      const prefix = match[1] || ''; // group 1: start/newline
      const fence = match[3]; // group 3: backticks

      if (!fence) continue;

      const fenceLength = fence.length;

      const rest = text.slice(matchIndex + match[0].length);
      const identifierMatch = rest.match(/^([^\r\n]*)/); // Match up to end of line
      const identifierLine = identifierMatch ? (identifierMatch[1] || '') : '';
      const lang = identifierLine.trim();

      if (currentBlock) {
        // Trying to close
        if (fenceLength >= currentBlock.fenceLength && lang === '') {
          // Closed normally
          currentBlock = null;

          // Was this an interesting block?
          if (specificLangs) {
            // We can't check variable like blockLang here because local scoping,
            // but we're just checking "did we close *something* interesting"?
            // Actually logic says: if we find a closing fence, we need to know what we closed.
            // But we lost `blockLang`. Let's refactor loop to keep track properly.
            // Wait, I can just use getAllBlocks logic but return true immediately.
            return true;
          } else {
            return true;
          }
        } else if (lang && this.isPriorityLang(lang)) {
          // Priority block found inside an unclosed block -> Implicitly closed previous block!
          // This means we have a closed block (the previous one).
          const prevLang = currentBlock.lang;

          if (specificLangs) {
            if (specificLangs.includes(prevLang.toLowerCase())) return true;
          } else {
            if (this.isInterestingBlock(prevLang)) return true;
          }

          // Start the new priority block
          currentBlock = {
            start: matchIndex,
            lang: lang,
            depth: 0,
            fenceLength: fenceLength
          };
        }
      } else {
        // Open new block
        if (lang) {
          currentBlock = {
            start: matchIndex,
            lang: lang,
            depth: 0,
            fenceLength: fenceLength
          };
        }
      }
    }
    return false;
  }

  wrapThinking(content: string): string {
    return `\`\`\`think\n${content}\n\`\`\``;
  }

  wrapAction(content: string): string {
    return `\`\`\`action\n${content}\n\`\`\``;
  }

  wrapObservation(content: string): string {
    return `\`\`\`observation\n${content}\n\`\`\``;
  }

  wrapCli(content: string): string {
    return `\`\`\`cli\n${content}\n\`\`\``;
  }

  wrapSkills(content: string): string {
    return `\`\`\`skills\n${content}\n\`\`\``;
  }

  getDescription(): string {
    return `## Syntax (Markdown)

- \`\`\`cli ... \`\`\` for WINDOWS POWERSHELL command execution.
- \`\`\`./path/to/file.ext ... \`\`\` to create/write ANY files, e.g. - txt, md, js, ts, py, etc.
- \`\`\`edit filename.ext ... \`\`\` to edit existing files using Search & Replace:
  \`\`\`edit app.ts
  <<<< SEARCH
  old code
  >>>>
  <<<< REPLACE
  new code
  >>>>
  \`\`\`
- \`\`\`action ... \`\`\` for one-off TypeScript code execution. Use \`console.log()\` to surface results. Tools (like 'search') are auto-imported.
- \`\`\`observation ... \`\`\` is system output from \`console.log()\`.`;
  }

  // Helpers

  /**
   * Priority language identifiers that can implicitly close a previous unclosed block.
   * This handles cases where LLM forgets to close a think/thought block before starting action.
   */
  private readonly PRIORITY_LANGS = ['action', 'cli', 'observation'];

  private isPriorityLang(lang: string): boolean {
    const l = lang.toLowerCase();
    return this.PRIORITY_LANGS.includes(l) || l.startsWith('edit ');
  }

  private isInterestingBlock(lang: string): boolean {
    const l = lang.toLowerCase();
    return l === 'action' || l === 'cli' || l === 'diff' || l.startsWith('edit ') || this.isFilePath(l);
  }

  private getAllBlocks(text: string): { lang: string; content: string; closed: boolean }[] {
    const blocks: { lang: string; content: string; closed: boolean }[] = [];
    const regex = /(^|\r?\n)([ \t]*)(`{3,})/g;
    let match;

    let currentBlock: { start: number; lang: string; contentStart: number; fenceLength: number } | null = null;

    while ((match = regex.exec(text)) !== null) {
      const matchIndex = match.index;
      const prefix = match[1] || ''; // group 1: start/newline
      const fence = match[3]; // group 3: backticks

      if (!fence) continue;

      const fenceLength = fence.length;

      const rest = text.slice(matchIndex + match[0].length);
      const identifierMatch = rest.match(/^([^\r\n]*)/);
      const identifierLine = identifierMatch ? (identifierMatch[1] || '') : '';
      const lang = identifierLine.trim();

      if (currentBlock) {
        // Trying to close
        if (fenceLength >= currentBlock.fenceLength && lang === '') {
          // Closed normally
          const contentEnd = matchIndex + prefix.length;
          const content = text.slice(currentBlock.contentStart, contentEnd).trim();

          blocks.push({
            lang: currentBlock.lang,
            content: content,
            closed: true
          });
          currentBlock = null;
        } else if (lang && this.isPriorityLang(lang)) {
          // Priority block found inside an unclosed block!
          // Implicitly close the previous block and start this one.
          const contentEnd = matchIndex + prefix.length;
          const content = text.slice(currentBlock.contentStart, contentEnd).trim();

          blocks.push({
            lang: currentBlock.lang,
            content: content,
            closed: true // It WAS closed implicitly by the start of the next one
          });

          // Start the new priority block
          const contentStart = matchIndex + match[0].length + identifierLine.length;
          currentBlock = {
            start: matchIndex,
            lang: lang,
            contentStart: contentStart,
            fenceLength: fenceLength
          };
        }
      } else {
        // Open new block
        if (lang) {
          const contentStart = matchIndex + match[0].length + identifierLine.length;
          currentBlock = {
            start: matchIndex,
            lang: lang,
            contentStart: contentStart,
            fenceLength: fenceLength
          };
        }
      }
    }

    // Handle unclosed blocks
    if (currentBlock) {
      const content = text.slice(currentBlock.contentStart).trim();
      blocks.push({
        lang: currentBlock.lang,
        content: content,
        closed: false // Explicitly mark as NOT closed
      });
    }

    return blocks;
  }
  private isExecutableLang(lang: string): boolean {
    const l = lang.toLowerCase();
    return ['typescript', 'ts', 'javascript', 'js', 'python', 'py', 'bash', 'sh', 'action'].includes(l);
  }

  private isFilePath(lang: string): boolean {
    // Check if it looks like a path
    return lang.includes('/') || lang.includes('\\') || lang.startsWith('.');
  }
}

registerSyntax('markdown', () => new MarkdownSyntax());

export default MarkdownSyntax;
