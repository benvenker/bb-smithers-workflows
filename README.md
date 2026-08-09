# bb-smithers-workflows

Native Smithers 0.33 workflows shared by BB plugin repositories. The installable pack lives in `pack/`; repository tests and fixtures stay outside it.

## Install

Develop against a local checkout:

```bash
cd /path/to/bb-plugin
./.smithers/node_modules/.bin/smithers add file:/path/to/bb-smithers-workflows/pack --yes
```

Pin a published immutable GitHub revision:

```bash
./.smithers/node_modules/.bin/smithers add github:benvenker/bb-smithers-workflows/pack#COMMIT_SHA --yes
```

Smithers installs the pack under `.smithers/packs/bb-smithers-workflows/` and records its source, resolved revision, version, and integrity in `.smithers/packs.lock.toon`. Update the recorded source with:

```bash
./.smithers/node_modules/.bin/smithers packs update bb-smithers-workflows
```

## Configure

Each consumer owns `.bb/release-gate.json`. Commands are executable/argv records and never pass through a shell:

```json
{
  "schemaVersion": 1,
  "packageManager": "npm",
  "staticChecks": [
    { "id": "typecheck", "executable": "$packageManager", "args": ["run", "typecheck"] },
    { "id": "ubs", "executable": "ubs", "args": ["--ci", "."] }
  ],
  "harness": {
    "backend": { "executable": "$packageManager", "args": ["test", "--", "server.test.ts"] }
  },
  "harnessSources": { "backend": ["server.test.ts"] },
  "build": { "executable": "$packageManager", "args": ["run", "build"] },
  "artifacts": [{ "path": "dist/server.js", "required": true, "minBytes": 1 }],
  "requireReleaseApproval": true,
  "rollout": {
    "pluginId": "example",
    "source": "git:https://github.com/example/plugin.git@main"
  },
  "releaseActions": {
    "install": { "executable": "bb", "args": ["plugin", "install", "git:https://github.com/example/plugin.git@main", "--yes", "--json"] },
    "update": { "executable": "bb", "args": ["plugin", "update", "example", "--yes"] },
    "reload": { "executable": "bb", "args": ["plugin", "reload", "example", "--json"] }
  }
}
```

Verify commands reject shell wrappers, Git/GitHub commands, package installation or publishing, and live BB plugin mutations. A declared backend or frontend surface must have a command that targets a declared source file importing the corresponding official `@bb/plugin-sdk/testing` module. A failed or untargeted harness blocks before release actions.

Mutating `liveChecks` must declare a rollback; `verifyRollback` is optional. `releaseActions` run only in explicit release mode after verification and live acceptance pass. Set `requireReleaseApproval` to `false` only when the consumer intentionally does not need the one final Smithers approval.

Managed release mode uses `rollout.pluginId` and `rollout.source` plus `install`, `update`, and `reload` actions. It installs an absent plugin, updates the intended managed source when its SHA is older, skips the mutation when already current, always reloads, and refuses incompatible or indeterminate registrations. Success still requires `bb plugin source <id> --json` to report the consumer's exact captured `HEAD` revision.

Consumers temporarily using `file:vendor/*.tgz` for `@bb/plugin-sdk` are checked against `engines.bbPluginSdk` on every gate run. The gate fails with migration instructions as soon as a compatible official package exists; registry outages are reported as indeterminate.

## Run

```bash
cd /path/to/bb-plugin
./.smithers/node_modules/.bin/smithers workflow run bb-smithers-workflows:bb-plugin-release-gate \
  --input '{"pluginRoot":"/absolute/path/to/bb-plugin","mode":"verify"}'
```

Use `"mode":"release"` only when configured live checks and release actions are intended. Until a consumer removes a same-named local prototype, use the qualified ID shown above; afterward the ordinary `bb-plugin-release-gate` ID resolves to the installed pack.

From the consumer root, start or inspect the durable Gateway with `./.smithers/node_modules/.bin/smithers gateway`, list runs with `./.smithers/node_modules/.bin/smithers ps`, inspect a run with `./.smithers/node_modules/.bin/smithers inspect RUN_ID`, and resume one with `./.smithers/node_modules/.bin/smithers resume RUN_ID`. Keeping the consumer root as the workspace makes native workflow discovery, run storage, and the Gateway UI agree.

## Develop

```bash
bun install
bun run check
```
