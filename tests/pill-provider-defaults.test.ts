import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, PILL_CLI_DEFAULT_AUDIT_MODEL } from '../tools/pill/config.js';
import {
  DEFAULT_NVIDIA_LLM_MODEL,
  DEFAULT_OLLAMA_LLM_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_LLM_MODEL,
} from '../shared/constants.js';

function mkDir(): string {
  return mkdirSync(join(tmpdir(), `pill-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
    recursive: true,
  });
}

const baseInput = {
  outputOnly: false,
  promptsOnly: false,
  dryRun: false,
  verbose: false,
};

beforeEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_CLOUD_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ELIZACLOUD_API_KEY;
  delete process.env.PILL_LLM_PROVIDER;
  delete process.env.PILL_AUDIT_MODEL;
  delete process.env.PILL_LLM_MODEL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.LMSTUDIO_API_KEY;
});

afterEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_CLOUD_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ELIZACLOUD_API_KEY;
  delete process.env.PILL_LLM_PROVIDER;
  delete process.env.PILL_AUDIT_MODEL;
  delete process.env.PILL_LLM_MODEL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.LMSTUDIO_API_KEY;
});

describe('pill loadConfig provider default models', () => {
  it('uses NVIDIA defaults when only NVIDIA key is set (CLI audit still Anthropic default)', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'NVIDIA_API_KEY=test-nvidia-key-for-pill\n', 'utf-8');
      const c = loadConfig({
        targetDir: dir,
        auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
        ...baseInput,
      });
      expect(c.llmProvider).toBe('nvidiacloud');
      expect(c.auditModel).toBe(DEFAULT_NVIDIA_LLM_MODEL);
      expect(c.llmModel).toBe(DEFAULT_NVIDIA_LLM_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses OpenRouter defaults when only OPENROUTER_API_KEY is set', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-test\n', 'utf-8');
      const c = loadConfig({
        targetDir: dir,
        auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
        ...baseInput,
      });
      expect(c.llmProvider).toBe('openrouter');
      expect(c.auditModel).toBe(DEFAULT_OPENROUTER_LLM_MODEL);
      expect(c.llmModel).toBe(DEFAULT_OPENROUTER_LLM_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses OpenAI defaults when only OPENAI_API_KEY is set and CLI audit is Anthropic default', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=sk-test\n', 'utf-8');
      const c = loadConfig({
        targetDir: dir,
        auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
        ...baseInput,
      });
      expect(c.llmProvider).toBe('openai');
      expect(c.auditModel).toBe(DEFAULT_OPENAI_MODEL);
      expect(c.llmModel).toBe(DEFAULT_OPENAI_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps explicit CLI audit model on OpenRouter', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-test\n', 'utf-8');
      const c = loadConfig({
        targetDir: dir,
        auditModel: 'anthropic/claude-3-5-haiku-20241022',
        ...baseInput,
      });
      expect(c.auditModel).toBe('anthropic/claude-3-5-haiku-20241022');
      expect(c.llmModel).toBe(DEFAULT_OPENROUTER_LLM_MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows colon in model id from .env', () => {
    const dir = mkDir();
    try {
      writeFileSync(
        join(dir, '.env'),
        'OPENAI_API_KEY=sk-test\nPILL_LLM_MODEL=gpt-oss:20b\n',
        'utf-8',
      );
      const c = loadConfig({
        targetDir: dir,
        auditModel: 'gpt-4o',
        ...baseInput,
      });
      expect(c.llmModel).toBe('gpt-oss:20b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses Ollama defaults when PILL_LLM_PROVIDER=ollama (no cloud keys)', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'PILL_LLM_PROVIDER=ollama\n', 'utf-8');
      const c = loadConfig({
        targetDir: dir,
        auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
        ...baseInput,
      });
      expect(c.llmProvider).toBe('ollama');
      expect(c.auditModel).toBe(DEFAULT_OLLAMA_LLM_MODEL);
      expect(c.llmModel).toBe(DEFAULT_OLLAMA_LLM_MODEL);
      expect(c.ollamaApiKey).toBe('ollama');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when PILL_LLM_PROVIDER=lmstudio without PILL_LLM_MODEL', () => {
    const dir = mkDir();
    try {
      writeFileSync(join(dir, '.env'), 'PILL_LLM_PROVIDER=lmstudio\n', 'utf-8');
      expect(() =>
        loadConfig({
          targetDir: dir,
          auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
          ...baseInput,
        }),
      ).toThrow(/PILL_LLM_MODEL is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts lmstudio when PILL_LLM_MODEL is set', () => {
    const dir = mkDir();
    try {
      writeFileSync(
        join(dir, '.env'),
        'PILL_LLM_PROVIDER=lmstudio\nPILL_LLM_MODEL=my-local-id\n',
        'utf-8',
      );
      const c = loadConfig({
        targetDir: dir,
        auditModel: PILL_CLI_DEFAULT_AUDIT_MODEL,
        ...baseInput,
      });
      expect(c.llmProvider).toBe('lmstudio');
      expect(c.auditModel).toBe('my-local-id');
      expect(c.llmModel).toBe('my-local-id');
      expect(c.lmstudioApiKey).toBe('lm-studio');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
