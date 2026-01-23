
import { validateTool } from './src/config.ts';

const tools = ['cursor', 'opencode', 'claude-code', 'aider', 'codex', 'llm-api'];

console.log('Testing validateTool...');

let allValid = true;
for (const tool of tools) {
  try {
    const res = validateTool(tool);
    if (res !== tool) {
      console.error(`FAIL: ${tool} returned ${res}`);
      allValid = false;
    } else {
      // console.log(`OK: ${tool}`);
    }
  } catch (e) {
    console.error(`FAIL: ${tool} threw error: ${e}`);
    allValid = false;
  }
}

try {
  validateTool('invalid-tool');
  console.error('FAIL: invalid-tool should have thrown');
  allValid = false;
} catch (e) {
  // console.log('OK: invalid-tool threw error');
}

if (allValid) {
  console.log('SUCCESS: All tools validated correctly.');
} else {
  console.log('FAILURE: Some validations failed.');
  process.exit(1);
}
