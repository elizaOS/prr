# Installing the PRR workflow in your repo

This guide is for **maintainers of another repository** who want to run [PRR](https://github.com/elizaOS/prr) (PR review resolver) on their PRs via GitHub Actions, without hosting the tool. PRR runs in this repo and acts on your PR using your token.

## 1. Add the workflow file

Create `.github/workflows/run-prr.yml` in your repo with the following content.

**Minimal (manual trigger only):**

```yaml
name: Run PRR

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to run PRR on'
        required: true
        type: number

jobs:
  prr:
    permissions:
      contents: write      # required by reusable workflow (checkout + PRR push)
      pull-requests: write # required by reusable workflow (submit PR review)
    uses: elizaOS/prr/.github/workflows/run-prr-server.yml@babylon
    with:
      pr_number: ${{ inputs.pr_number }}
      prr_repo: 'elizaOS/prr'
      prr_ref: 'babylon'
      submit_review: true   # so PRR can post a review/comment when run manually
    secrets:
      PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ELIZACLOUD_API_KEY: ${{ secrets.ELIZACLOUD_API_KEY }}
      # or: ANTHROPIC_API_KEY / OPENAI_API_KEY (one LLM provider is enough)
```

**Optional:** To also run when someone adds the label `run-prr` or requests a specific user as reviewer, use:

```yaml
name: Run PRR

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to run PRR on'
        required: true
        type: number
  pull_request:
    types: [labeled, review_requested]

concurrency:
  group: prr-${{ github.event.pull_request.number || inputs.pr_number || github.run_id }}
  cancel-in-progress: false

jobs:
  prr:
    permissions:
      contents: write      # required by reusable workflow (checkout + PRR push)
      pull-requests: write # required by reusable workflow (submit PR review)
    if: |
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'pull_request' && (
        (github.event.action == 'labeled' && github.event.label.name == 'run-prr') ||
        (github.event.action == 'review_requested' && vars.PRR_REVIEWER_LOGIN && github.event.requested_reviewer && github.event.requested_reviewer.login == vars.PRR_REVIEWER_LOGIN)
      ))
    uses: elizaOS/prr/.github/workflows/run-prr-server.yml@babylon
    with:
      pr_number: ${{ github.event_name == 'workflow_dispatch' && inputs.pr_number || github.event.pull_request.number }}
      prr_repo: 'elizaOS/prr'
      prr_ref: 'babylon'
      submit_review: ${{ github.event_name == 'workflow_dispatch' }}
    secrets:
      PRR_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      ELIZACLOUD_API_KEY: ${{ secrets.ELIZACLOUD_API_KEY }}
```

If you use the optional triggers, set a **repository variable** (Settings → Secrets and variables → Actions → Variables): `PRR_REVIEWER_LOGIN` = the login of the user that, when requested as a reviewer, should trigger PRR (e.g. a bot account). Leave it empty to disable the “request reviewer” trigger.

## 2. Add repository secrets

In your repo: **Settings → Secrets and variables → Actions**.

| Secret | Required | Description |
|--------|----------|-------------|
| `PRR_GITHUB_TOKEN` | No (use `GITHUB_TOKEN`) | Pass `secrets.GITHUB_TOKEN` in the workflow; no extra secret needed. Or use a PAT for cross-repo or higher limits. |
| One of: `ELIZACLOUD_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Yes | At least one LLM API key so PRR can run the fixer. |

## 3. Run it

- **Manual:** Actions → **Run PRR** → **Run workflow** → enter the PR number.
- **Label:** Add the label `run-prr` to the PR (if you added the optional triggers).
- **Reviewer:** Request the user set in `PRR_REVIEWER_LOGIN` as a reviewer (if configured).

## 4. Pin to a branch or tag (optional)

The example uses `@babylon`. To pin to a tag or another branch:

```yaml
uses: elizaOS/prr/.github/workflows/run-prr-server.yml@v1.0.0
# or
uses: elizaOS/prr/.github/workflows/run-prr-server.yml@main
```

Replace `elizaOS/prr` with the actual owner/repo if PRR is hosted elsewhere.
