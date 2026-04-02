# Test Framework

This directory contains the comprehensive test framework for PRR and related tools.

## Structure

### Unit Tests (`tests/`)
Existing unit tests for pure functions, parsers, formatters.

### Integration Tests (`tests/`)
Subsystem tests with mocks (git ops, LLM client).

### Evals (`tests/evals/`)
**Evaluation framework for stochastic tools** - measures actual performance with real LLMs.

- `benchmark/` - Golden datasets for each tool
- `runner/` - Eval execution engine
- `prr/`, `pill/`, `split-plan/`, `story/` - Tool-specific eval tests

See [tests/evals/README.md](evals/README.md) for details.

### Scenario Tests (`tests/scenarios/`)
Mock-based scenario tests for workflow correctness.

- `helpers/` - Assertions and workflow execution helpers
- `fixtures/` - Test repository fixtures
- `*.scenario.ts` - Scenario test files

### Test Utilities (`tests/test-utils/`)
Shared utilities for all tests.

- `github-mock.ts` - Mock GitHub API
- `git-helpers.ts` - Git repository setup
- `llm-mock.ts` - Mock LLM client
- `scenario-builder.ts` - Scenario construction

### Deterministic Tool Tests
- `tests/split-rewrite-plan/` - Tests for split-rewrite-plan (git operations)
- `tests/split-exec/` - Tests for split-exec (git operations, PR creation)

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm test -- tests/ --run

# Scenario tests
npm test -- tests/scenarios/ --run

# Evals (requires API keys)
npm run eval -- run -t prr -b simple-fix
```

## Testing Strategy

1. **Unit tests** (fast, deterministic): Pure functions, parsers, formatters
2. **Scenario tests** (medium speed, mocked): Workflow integration with mocks
3. **Evals** (slower, stochastic): Real tool runs on benchmark datasets with actual LLMs
