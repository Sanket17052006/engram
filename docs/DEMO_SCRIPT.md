# Engram demo script (3–4 minutes)

## Before the demo

1. Start FalkorDB, the FastAPI core, and the Next.js app; sign in and select a repository.
2. In `.env.local`, configure `ENGRAM_REPAIR_CHECKOUTS` with a local checkout, `ENGRAM_REPAIR_ROOT` with a private directory outside the checkout, and `ENGRAM_REPAIR_ALLOWED_REPOSITORIES` with the exact `owner/repo` used in the demo.
3. For a trusted local demo checkout only, set `ENGRAM_ALLOW_UNSANDBOXED_REPAIR_TESTS=true`. Repair runs repository tests on the host; do not enable this for arbitrary user repositories or a public multi-user server.
4. Refresh GitHub activity and import the current code snapshot so the FalkorDB graph contains source files and linked tests. Pick a concrete open issue with both source and test relationships.

## Walkthrough

### 0:00–0:30 · Introduce the problem

**Say:** “Engram turns repository activity and source structure into a FalkorDB graph. That lets a contributor move from an issue report to related code, tests, and prior work, then review a proposed local repair with its evidence.”

**Show:** The selected repository, latest sync status, and the Code graph page.

### 0:30–1:00 · Select a real issue

**Say:** “I can choose an issue from the repository’s current GitHub data. Engram does not assume a particular issue number; the issue and repository are selected for this run.”

**Show:** Refresh GitHub issues, select an issue with enough detail, and click **Investigate with graph**. Point to the graph-selected files and tests.

### 1:00–1:40 · Start the repair

**Say:** “The investigator queries this repository’s FalkorDB code graph and follows the recorded file, symbol, import, and test relationships. Those graph results bound the source context sent to the configured model. Engram validates the model’s proposed patch before applying it.”

**Show:** Start **Fix selected issue** and wait for the operation. Explain the branch and base commit shown in the result.

### 1:40–2:30 · Inspect the review

**Say:** “The review brings together the issue, proposed summary, changed files, additions and removals, test output, and the graph trace that led to the affected code. If the patch is invalid or the targeted checks fail, Engram reports that instead of presenting it as a verified fix.”

**Show:** Review the diff and test result. Open **Issue-fix graph** and trace the selected issue through the stored code and test relationships.

### 2:30–3:15 · Verify the local Git state

**Say:** “For this local demo, the change is committed on an `engram/issue-*` branch based on the current upstream default branch. I can inspect the branch and commit directly in the repository checkout.”

**Show:** In the configured checkout, run:

```sh
git branch --show-current
git status --short
git log -1 --oneline
```

Then return to the review and show the **Approve patch** control as the final review step.

### 3:15–3:45 · Close

**Say:** “Engram uses FalkorDB to make the path from issue to code and tests visible, then gives a human a concrete patch and validation result to review. The graph is part of the investigation and evidence trail, not a decorative visualization.”

## Demo notes

- Use the actual issue, model response, branch, diff, and test output from the live run. Do not claim a fix is verified unless targeted tests pass.
- Repair and host-side test execution are disabled by default and should only be enabled for a trusted local checkout. They are not an isolation boundary for arbitrary repositories.
- The repair flow makes a local branch and commit. The review page is the handoff point; do not describe the approval control as creating a GitHub pull request.
