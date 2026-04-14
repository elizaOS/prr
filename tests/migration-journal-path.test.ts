import { describe, it, expect } from 'vitest';
import { getMigrationJournalPath } from '../tools/prr/analyzer/prompt-builder.js';
import type { UnresolvedIssue } from '../tools/prr/analyzer/types.js';

function issue(path: string, body: string): UnresolvedIssue {
  return {
    comment: {
      id: '1',
      threadId: 't',
      author: 'a',
      body,
      path,
      line: 1,
      createdAt: '',
    },
    codeSnippet: '',
    stillExists: true,
    explanation: '',
  };
}

describe('getMigrationJournalPath', () => {
  it('returns journal path when comment is on a migration sql and body mentions _journal.json', () => {
    const i = issue(
      'db/migrations/0001_foo.sql',
      'Add this migration to db/migrations/meta/_journal.json so Drizzle discovers it.',
    );
    expect(getMigrationJournalPath(i)).toBe('db/migrations/meta/_journal.json');
  });

  it('matches journal discovery phrasing without literal _journal.json', () => {
    const i = issue(
      'DB/Migrations/0002_bar.sql',
      'You need to update the journal to discover new migrations.',
    );
    expect(getMigrationJournalPath(i)).toBe('db/migrations/meta/_journal.json');
  });

  it('returns null when path is not under db/migrations/*.sql', () => {
    const i = issue(
      'src/db/migrations/0001_foo.sql',
      'Update _journal.json',
    );
    expect(getMigrationJournalPath(i)).toBeNull();
  });

  it('returns null when path is migration sql but body does not mention journal', () => {
    const i = issue('db/migrations/0001_foo.sql', 'Fix typo in CREATE TABLE.');
    expect(getMigrationJournalPath(i)).toBeNull();
  });
});
