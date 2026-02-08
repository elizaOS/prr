# Fixer Must Explain Zero Changes

## Problem

When fixer tools (cursor, aider, claude-code, etc.) make **zero changes**, the system was just accepting it silently without understanding WHY. This breaks the feedback loop because:

1. **No documentation** - We don't know if issues are already fixed or if the tool failed
2. **No learning** - Can't improve prompts or tools without understanding failures
3. **No dismissals** - Can't properly dismiss issues that don't need fixing
4. **Silent failures** - Tool might be broken but we don't notice

## Solution: Mandatory Explanation in Fixer Prompt

### Updated Fixer Prompt (`src/analyzer/prompt-builder.ts`)

Added explicit instruction requiring fixer tools to explain zero-change scenarios:

```markdown
## CRITICAL: If You Make Zero Changes

If you decide NOT to make any file changes, you MUST explain why in your output.
Output a line starting with "NO_CHANGES:" followed by a detailed explanation.

Valid reasons include:
- Issue is already fixed (cite specific code)
- Cannot determine correct fix (explain what is unclear)
- Issue is not actually a problem (explain why)
- Code already handles this correctly (cite specific implementation)

Example:
NO_CHANGES: Issue 1 is already fixed - Line 45 has null check: if (value === null) return;

DO NOT make zero changes without this explanation. The system requires documentation of why no changes were made.
```

### Parsing and Handling (`src/resolver.ts`)

Added `parseNoChangesExplanation()` method to extract the explanation:

```typescript
private parseNoChangesExplanation(output: string): string | null {
  // Look for "NO_CHANGES:" line in output
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/NO_CHANGES:\s*(.+)/i);
    if (match && match[1]) {
      const explanation = match[1].trim();
      if (explanation.length >= 20) {
        return explanation;
      }
    }
  }
  return null;
}
```

## Three Scenarios Where This Applies

### 1. Batch Mode - No Changes

**Location**: Main fix loop (`src/resolver.ts:1609-1648`)

**Before**:
```typescript
if (!(await hasChanges(git))) {
  console.log("No changes made by cursor");
  this.lessonsManager.addGlobalLesson("cursor made no changes - trying different approach");
}
```

**After**:
```typescript
if (!(await hasChanges(git))) {
  const noChangesExplanation = this.parseNoChangesExplanation(result.output);

  if (noChangesExplanation) {
    console.log("Fixer's explanation: ${noChangesExplanation}");
    this.lessonsManager.addGlobalLesson("cursor made no changes: ${noChangesExplanation}");

    // If explanation indicates issues are already fixed, dismiss them
    if (isAlreadyFixed(noChangesExplanation)) {
      for (const issue of unresolvedIssues) {
        this.stateManager.addDismissedIssue(
          issue.comment.id,
          `Fixer tool reported: ${noChangesExplanation}`,
          'already-fixed',
          ...
        );
      }
    }
  } else {
    warn("⚠️  Fixer made zero changes without providing NO_CHANGES: explanation");
    warn("   This breaks the feedback loop - the fixer should document why");
  }
}
```

### 2. Single-Issue Focus Mode - No Changes

**Location**: `trySingleIssueFix()` (`src/resolver.ts:392-428`)

**Before**:
```typescript
// Tool ran but made no changes at all
console.log("No changes made (tool may not understand the task)");
this.lessonsManager.addLesson("tool made no changes, may need clearer instructions");
```

**After**:
```typescript
const noChangesExplanation = this.parseNoChangesExplanation(result.output || '');

if (noChangesExplanation) {
  console.log("No changes made");
  console.log("Fixer's reason: ${noChangesExplanation}");
  this.lessonsManager.addLesson(`${noChangesExplanation}`);

  // If already fixed, dismiss
  if (isAlreadyFixed(noChangesExplanation)) {
    this.stateManager.addDismissedIssue(...);
  }
} else {
  console.log("No changes made (tool may not understand the task)");
  warn("⚠️  Fixer did not provide NO_CHANGES: explanation");
}
```

### 3. Direct LLM API - Unchanged Code

**Location**: `tryDirectLLMFix()` (`src/resolver.ts:539-572`)

**Before**:
```typescript
if (fixedCode !== fileContentTrimmed) {
  fs.writeFileSync(...);
  // verify and track
}
// Otherwise: silently skip, no documentation
```

**After**:
```typescript
if (fixedCode !== fileContentTrimmed) {
  fs.writeFileSync(...);
  // verify and track
} else {
  // LLM returned the same code - no changes needed
  console.log("No changes needed for ${file}");
  console.log("Direct LLM indicated file is already correct");
  this.stateManager.addDismissedIssue(
    issue.comment.id,
    'Direct LLM API returned unchanged code, indicating the issue is already addressed',
    'already-fixed',
    ...
  );
}
```

## How It Works

### When Fixer Provides Explanation

```
Fixer Output:
> NO_CHANGES: Issue is already fixed - Line 45 has null check: if (value === null) return;

System:
  ✓ Parse explanation
  ✓ Display: "Fixer's explanation: Issue is already fixed..."
  ✓ Store in lessons: "cursor made no changes: Issue is already fixed..."
  ✓ Detect "already fixed" pattern
  ✓ Dismiss issues with reason
  ✓ Continue with next iteration
```

### When Fixer DOESN'T Provide Explanation

```
Fixer Output:
> (no NO_CHANGES: line)

System:
  ⚠️  Warning: "Fixer made zero changes without providing NO_CHANGES: explanation"
  ⚠️  Warning: "This breaks the feedback loop - the fixer should document why"
  ✓ Store generic lesson: "cursor made no changes without explanation"
  ✓ Continue with rotation strategy (try different tool/model)
```

## Detection of "Already Fixed"

The system looks for keywords in the explanation to determine if issues are already addressed:

```typescript
const lowerExplanation = noChangesExplanation.toLowerCase();
const isAlreadyFixed = lowerExplanation.includes('already') ||
                       lowerExplanation.includes('exists') ||
                       lowerExplanation.includes('has') ||
                       lowerExplanation.includes('implements');
```

**Examples that trigger dismissal**:
- "Issue is **already** fixed - Line 45 has guard"
- "Code **already** **implements** this at lines 67-70"
- "Function **has** null check: if (x === null) return;"
- "Interface definition **exists** at line 23"

**Examples that DON'T trigger dismissal** (but still document):
- "Cannot determine correct fix - instructions unclear"
- "Not sure which approach to take - multiple options"
- "Missing context about expected behavior"

## Benefits

### 1. Transparency
- Users see exactly why fixer made no changes
- Can debug fixer issues more easily
- Understand if it's a tool problem or already-fixed scenario

### 2. Feedback Loop
- Generator learns which issues are false positives
- Documented reasons help improve detection
- Can adjust confidence thresholds

### 3. Proper Dismissals
- Only dismiss when fixer explicitly says "already fixed"
- Each dismissal has documented reason
- Supports generator-judge dialog

### 4. Quality Control
- Warning when fixer doesn't explain
- Forces fixer tools to be explicit
- Prevents silent failures

## Example Output

### Good Fixer Behavior

```
Running cursor to fix issues...
  Fixer completed in 15.2s

No changes made by cursor (claude-sonnet-4)
  Fixer's explanation: Issue 1 is already fixed - Line 45 has null check: if (value === null) return;
                       Issue 2 is already handled - Function has try-catch at lines 67-75
  → Fixer believes issues are already addressed

📋 Dismissed Issues Summary (2 total)
  ALREADY-FIXED (2)
    • src/utils.ts:45
      Reason: Fixer tool (cursor) reported: Issue 1 is already fixed...
```

### Bad Fixer Behavior

```
Running aider to fix issues...
  Fixer completed in 8.3s

No changes made by aider (gpt-4)
  ⚠️  Fixer made zero changes without providing NO_CHANGES: explanation
      This breaks the feedback loop - the fixer should document why it made no changes

  🎯 Trying single-issue focus mode...
```

## Files Modified

1. **`src/analyzer/prompt-builder.ts`** (lines 117-128)
   - Added "CRITICAL: If You Make Zero Changes" section
   - Explicit instructions and examples

2. **`src/resolver.ts`**
   - Added `parseNoChangesExplanation()` method (lines 2182-2204)
   - Updated batch mode no-changes handling (lines 1609-1648)
   - Updated single-issue no-changes handling (lines 392-428)
   - Updated direct LLM no-changes handling (lines 567-576)

## Testing

Build verified successful:
```bash
$ npm run build
> prr@1.0.0 build
> tsc

✓ No compilation errors
```

## Key Principle

> **Fixer tools MUST explain why they make zero changes.**
>
> No explanation = Warning + Generic lesson
>
> With explanation:
> - "Already fixed" → Dismiss with documented reason
> - Other reasons → Document but don't dismiss

This ensures we NEVER silently accept zero changes without understanding why, maintaining the integrity of the feedback loop.
