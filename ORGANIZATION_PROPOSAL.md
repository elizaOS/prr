# Source Code Organization Proposal

## Problem

Two folders are cluttered with too many files at one level:
1. **src/state/** - 26 files (10 state + 14 lessons + 2 shared)
2. **src/git/** - 20 files (all git operations mixed together)

## Proposed Organization

### Option A: Subfolder by Subsystem (RECOMMENDED)

```
src/state/
├── resolver/           # Resolver state (10 files)
│   ├── context.ts
│   ├── core.ts
│   ├── verification.ts
│   ├── dismissed.ts
│   ├── lessons.ts
│   ├── iterations.ts
│   ├── rotation.ts
│   ├── performance.ts
│   ├── bailout.ts
│   └── index.ts
├── lessons/            # Lessons system (14 files)
│   ├── context.ts
│   ├── paths.ts
│   ├── load.ts
│   ├── normalize.ts
│   ├── parse.ts
│   ├── format.ts
│   ├── prune.ts
│   ├── save.ts
│   ├── sync.ts
│   ├── detect.ts
│   ├── add.ts
│   ├── retrieve.ts
│   ├── compact.ts
│   └── index.ts
├── index.ts            # Main facade
├── types.ts            # Shared types
└── lock-functions.ts   # Lock utilities

src/git/
├── commit/             # Commit operations (7 files)
│   ├── core.ts
│   ├── query.ts
│   ├── iteration.ts
│   ├── scan.ts
│   ├── message.ts
│   ├── push.ts
│   └── index.ts
├── clone/              # Clone operations (7 files)
│   ├── core.ts
│   ├── diff.ts
│   ├── conflicts.ts
│   ├── pull.ts
│   ├── merge.ts
│   ├── lock-files.ts
│   └── index.ts
├── conflict/           # Conflict resolution (5 files)
│   ├── prompts.ts
│   ├── lockfiles.ts
│   ├── resolve.ts
│   ├── cleanup.ts
│   └── index.ts
├── index.ts            # Main facade
└── workdir.ts          # Shared utility
```

**Import changes:**
```typescript
// Before
import * as State from './state/index.js';
import * as LessonsAPI from './state/lessons-index.js';

// After
import * as State from './state/resolver/index.js';
import * as Lessons from './state/lessons/index.js';
// Or: import * as State from './state/index.js' (main facade re-exports)
```

**Benefits:**
- ✅ Clear separation: resolver vs lessons, commit vs clone vs conflict
- ✅ Easier navigation: Browse by subsystem
- ✅ Scalable: Easy to add new subsystems
- ✅ Standard pattern: Matches common project structure

**Drawbacks:**
- ⚠️ Need to update ~100 import statements
- ⚠️ Deeper nesting (state/resolver/core.ts vs state-core.ts)
- ⚠️ Risk of errors during migration

### Option B: Keep Current Structure (NO CHANGE)

```
src/state/
├── state-*.ts (10 files with clear prefix)
├── lessons-*.ts (14 files with clear prefix)
├── index.ts, types.ts, lock-functions.ts

src/git/
├── git-commit-*.ts (7 files)
├── git-clone-*.ts (7 files)
├── git-conflict-*.ts (5 files)
└── git-*.ts (shared)
```

**Benefits:**
- ✅ Already well-organized with prefixes
- ✅ No import changes needed
- ✅ Flat structure = easy to find files
- ✅ Alphabetically grouped (state-*, lessons-*, git-commit-*, etc)
- ✅ Zero risk

**Current issues (minor):**
- 26 files in state/ folder (but clearly prefixed)
- 20 files in git/ folder (but clearly prefixed)

### Option C: Partial Organization (COMPROMISE)

Only reorganize state/ (most cluttered), leave git/ as is:

```
src/state/
├── resolver/           # 10 state-* files
├── lessons/            # 14 lessons-* files  
├── index.ts
├── types.ts
└── lock-functions.ts

src/git/
├── git-*.ts (keep as is - prefixes work well)
```

**Benefits:**
- ✅ Fixes most cluttered folder
- ✅ Fewer import changes (~50 files vs ~100)
- ✅ git/ stays stable

## Recommendation

### I recommend: **Option B (NO CHANGE)**

**Why:**
1. **Prefixes work well** - Easy to find files (state-*, lessons-*, git-commit-*)
2. **Flat is simpler** - No deep nesting, less cognitive overhead
3. **Already organized** - Files are grouped alphabetically by prefix
4. **Zero risk** - No import changes, no chance of breaking anything
5. **You already have 34 commits** - More refactoring = more risk

**The current structure is actually quite good:**
- Clear prefixes group related files
- Easy to glob (state-*.ts, lessons-*.ts, git-commit-*.ts)
- Alphabetical sorting keeps groups together
- No confusion about where files go

### If you insist on reorganizing:

Choose **Option C** - Only fix state/ folder (most cluttered), leave git/ alone.

**Effort:** ~2 hours, ~50 import updates, moderate risk  
**Benefit:** Cleaner state/ folder  
**Risk:** Medium (many imports to update)

## My Advice

**Leave it as is.** The structure is working, builds are clean, and you're ready to push. Further reorganization has:
- ❌ High effort (100+ import updates)
- ❌ High risk (easy to break things)
- ❌ Low benefit (prefixes already organize well)

**Focus on:**
- ✅ Push these 34 commits
- ✅ Runtime testing
- ✅ New features

**Not on:**
- ❌ More reorganization for marginal gains
