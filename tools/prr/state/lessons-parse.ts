/**
 * Lessons parsing from markdown
 */

export function parseMarkdownLessons(content: string): {
  global: string[];
  files: Record<string, string[]>;
} {
  const result = {
    global: [] as string[],
    files: {} as Record<string, string[]>,
  };

  const lines = content.split('\n');
  let currentSection: 'none' | 'global' | 'byFile' = 'none';
  let currentFile: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '### Global') {
      currentSection = 'global';
      currentFile = null;
      continue;
    }

    if (trimmed === '### By File') {
      currentSection = 'byFile';
      currentFile = null;
      continue;
    }

    if (currentSection === 'byFile' && trimmed.startsWith('**') && trimmed.endsWith('**')) {
      currentFile = trimmed.replace(/^\*\*|\*\*$/g, '').trim();
      if (!result.files[currentFile]) {
        result.files[currentFile] = [];
      }
      continue;
    }

    if (currentSection === 'global' && trimmed.startsWith('- ')) {
      const lesson = trimmed.substring(2).trim();
      if (lesson) {
        result.global.push(lesson);
      }
      continue;
    }

    if (currentSection === 'byFile' && currentFile && trimmed.startsWith('- ')) {
      const lesson = trimmed.substring(2).trim();
      if (lesson) {
        result.files[currentFile].push(lesson);
      }
      continue;
    }
  }

  return result;
}
