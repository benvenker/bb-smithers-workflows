---
name: bb-plugin-release-gate
description: Verify or release a BB plugin through its repository-owned deterministic policy.
workflow: bb-plugin-release-gate
---

# BB Plugin Release Gate

Use this installed workflow for BB plugin repositories carrying `.bb/release-gate.json`. Verification executes exact argv commands without shell interpolation and never installs, publishes, commits, pushes, or reloads plugins.

Inputs:

- `pluginRoot`: absolute plugin repository path.
- `policyPath`: path relative to `pluginRoot`; defaults to `.bb/release-gate.json`.
- `mode`: `verify` (default) or explicit `release`.

Run the installed workflow:

```bash
./.smithers/node_modules/.bin/smithers workflow run bb-smithers-workflows:bb-plugin-release-gate \
  --input '{"pluginRoot":"/absolute/path/to/plugin","mode":"verify"}'
```

Release mode first completes deterministic verification and configured live checks. Every mutating live check executes its rollback and optional rollback verification. If `requireReleaseApproval` is true, one final Smithers approval binds the current acceptance evidence hash before configured release actions run.

Treat `waived` as non-blocking but distinct from `pass`. A missing official SDK harness for an applicable backend or frontend surface blocks unless an exact current policy waiver covers `harness:backend` or `harness:frontend`. Each configured harness command must target a declared repository-relative source importing the matching official BB testing module; the evidence records both the verified and targeted source paths.

For managed Git rollouts, configure `rollout.source` with install, update, and reload actions. Release mode installs when absent, updates an older matching source, reloads without another mutation when already current, and fails before mutation for a different or indeterminate registration. Failed live acceptance is asserted and exits nonzero.

Run Smithers from the consumer root so workflow discovery, run storage, and the Gateway share one workspace. Use `./.smithers/node_modules/.bin/smithers ps`, `inspect RUN_ID`, and `resume RUN_ID`. The installed workflow UI exposes the verdict, evidence, approval, run tree, and event stream.
