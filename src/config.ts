```
export function loadConfig(): Config {
  // Smart auto-detect: check which API key is available, prefer ElizaCloud
  const rawProvider = process.env.PRR_LLM_PROVIDER;
  const explicitProvider = rawProvider?.trim().toLowerCase();
  let llmProvider: LLMProvider;
  
  if (explicitProvider) {
    llmProvider = explicitProvider as LLMProvider;
  } else if (process.env.ELIZACLOUD_API_KEY) {
    llmProvider = 'elizacloud';
  } else if (process.env.ANTHROPIC_API_KEY) {
    llmProvider = 'anthropic';
  } else if (process.env.OPENAI_API_KEY) {
    llmProvider = 'openai';
  } else {
    llmProvider = 'gpt-4'; // Updated to a valid identifier
  }

  // Validate normalized provider value
  if (llmProvider !== 'elizacloud' && llmProvider !== 'anthropic' && llmProvider !== 'openai') {
    throw new Error(`Invalid LLM provider: ${rawProvider}. Must be 'elizacloud', 'anthropic', or 'openai'`);
  }

  // Rest of loadConfig() stays exactly the same...
}
```
