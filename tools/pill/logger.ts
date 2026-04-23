/**
 * Logging for pill: tee console to pill-output.log, full prompts/responses to pill-prompts.log.
 * Uses shared format (══════ delimiters, slugs) so pill can be pill'd later.
 * Prompt log uses appendFileSync so each write is immediately on disk (no stream buffering).
 */
import { writeFileSync, appendFileSync, createWriteStream } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import { finished } from 'stream/promises';
import type { WriteStream } from 'fs';

let outputLogStream: WriteStream | null = null;
let outputLogPath: string | null = null;
let promptLogPath: string | null = null;
let promptLogCounter = 0;

/** Same `requestId` on PROMPT + RESPONSE metadata as `shared/logger` (grep UUID to pair interleaved entries). */
const promptRequestIdBySlug = new Map<string, string>();

const DELIMITER = '\u2550'.repeat(70); // U+2550 BOX DRAWINGS DOUBLE HORIZONTAL

function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:\[[\x20-\x3F]*[\x40-\x7E]|\].*?(?:\x07|\x1B\\)|\(B)/g, '');
}

function promptSlug(counter: number, label: string): string {
  return `#${String(counter).padStart(4, '0')}/${label}`;
}

function safeStringify(value: unknown, pretty = false): string {
  try {
    return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeToPromptLog(
  slug: string,
  kind: 'PROMPT' | 'RESPONSE' | 'ERROR',
  label: string,
  body: string,
  metadata?: Record<string, unknown>
): void {
  if (!promptLogPath) return;
  try {
    const content = typeof body === 'string' ? body : String(body ?? '');
    if ((kind === 'PROMPT' || kind === 'RESPONSE') && (content.length === 0 || content.trim().length === 0)) {
      appendFileSync(
        promptLogPath,
        `--- PILL_PROMPTLOG_EMPTY_BODY slug=${slug} kind=${kind} label=${JSON.stringify(label)} at=${new Date().toISOString()} ---\n`,
        'utf-8',
      );
      return;
    }
    let header = `${DELIMITER}\n ${slug}  ${kind}: ${label} (${content.length} chars)\n`;
    header += ` ${new Date().toISOString()}\n`;
    if (metadata) header += ` ${safeStringify(metadata, true)}\n`;
    header += `${DELIMITER}\n`;
    appendFileSync(promptLogPath, header + content + `\n${DELIMITER}\n\n`, 'utf-8');
  } catch (err) {
    console.error('Prompt log write failed:', err);
  }
}

/**
 * Initialize output log tee. Call first with target directory so pill-output.log and
 * pill-prompts.log are written there (shared format).
 */
export function initOutputLog(targetDir: string): void {
  outputLogPath = join(targetDir, 'pill-output.log');
  writeFileSync(outputLogPath, '', 'utf-8');
  outputLogStream = createWriteStream(outputLogPath, { flags: 'a', encoding: 'utf-8' });

  promptLogPath = join(targetDir, 'pill-prompts.log');
  writeFileSync(promptLogPath, '', 'utf-8');
  promptRequestIdBySlug.clear();

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  function logToStream(...args: unknown[]): void {
    if (!outputLogStream) return;
    try {
      const text = format(...args);
      const clean = stripAnsi(text);
      if (clean) outputLogStream.write(clean + '\n');
    } catch (err) {
      origError('Log stream write failed:', err);
    }
  }

  (console as unknown as { log: (...a: unknown[]) => void }).log = (...args: unknown[]) => {
    logToStream(...args);
    origLog(...args);
  };
  (console as unknown as { warn: (...a: unknown[]) => void }).warn = (...args: unknown[]) => {
    logToStream(...args);
    origWarn(...args);
  };
  (console as unknown as { error: (...a: unknown[]) => void }).error = (...args: unknown[]) => {
    logToStream(...args);
    origError(...args);
  };
}

export async function closeOutputLog(): Promise<void> {
  if (outputLogStream) {
    const stream = outputLogStream;
    outputLogStream = null;
    stream.end();
    try {
      await finished(stream);
    } catch {
      // ignore
    }
  }
  promptLogPath = null;
  promptRequestIdBySlug.clear();
}

export function getOutputLogPath(): string | null {
  return outputLogPath;
}

export function getPromptLogPath(): string | null {
  return promptLogPath;
}

/** Returns slug — pass to {@link debugResponse} / {@link debugPromptError} for the same request. */
export function debugPrompt(label: string, prompt: string, metadata?: Record<string, unknown>): string {
  promptLogCounter++;
  const slug = promptSlug(promptLogCounter, label);
  const requestId = randomUUID();
  promptRequestIdBySlug.set(slug, requestId);
  const mergedMeta = { ...metadata, requestId };
  writeToPromptLog(slug, 'PROMPT', label, prompt, mergedMeta);
  return slug;
}

export function debugResponse(slug: string, label: string, response: string, metadata?: Record<string, unknown>): void {
  const requestId = promptRequestIdBySlug.get(slug);
  const mergedMeta = requestId ? { ...metadata, requestId } : metadata;
  if (requestId) promptRequestIdBySlug.delete(slug);
  const trimmed = typeof response === 'string' ? response.trim() : '';
  if (!trimmed) {
    writeToPromptLog(
      slug,
      'ERROR',
      label,
      'Empty or whitespace-only response body (HTTP success; no RESPONSE written).',
      { ...mergedMeta, emptyBody: true },
    );
    return;
  }
  writeToPromptLog(slug, 'RESPONSE', label, response, mergedMeta);
}

export function debugPromptError(
  slug: string,
  label: string,
  errorMessage: string,
  metadata?: Record<string, unknown>,
): void {
  if (!promptLogPath) return;
  const requestId = promptRequestIdBySlug.get(slug);
  const mergedMeta = requestId ? { ...metadata, requestId } : metadata;
  if (requestId) promptRequestIdBySlug.delete(slug);
  writeToPromptLog(slug, 'ERROR', label, errorMessage, mergedMeta);
}

export function debug(_msg: string, _data?: unknown): void {
  // Only to console when verbose; log file gets everything via console.log
  // So we don't need to do anything special here - callers can use console.log for verbose
}
