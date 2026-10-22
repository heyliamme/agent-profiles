# Contributing

Thanks for helping. Bug reports, presets, ideas and pull requests are all welcome.

**Never paste a real API key** into an issue, a test or a screenshot.

## Reporting a bug

Open an issue with what you did, what you expected and what you saw. If a config file was
written wrongly, include the relevant part of the file before and after, with keys and
private addresses redacted.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/agent-profiles
cd agent-profiles
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host. That host writes your
real agent config when you apply a profile. To keep it away from your own setup, start VS
Code with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointing at scratch folders.

## Tests

```bash
npm run typecheck
npm test
```

The unit tests run on the engine in `src/core` (no VS Code), always in temporary folders:

- `test/claude.test.mjs`: merging `settings.json` (unrelated keys, comments, indentation,
  line endings), switching profiles, key modes, Bedrock / Vertex, validation,
  `CLAUDE_CONFIG_DIR`.
- `test/codex.test.mjs`: merging `config.toml` (comments, other tables, inline and dotted
  forms), providers, built-ins, `.env`, `experimental_bearer_token`, `CODEX_HOME`.
- `test/files.test.mjs`: atomic writes, permissions, symlinks, backup rotation, conflicts,
  restore.
- `test/connection.test.mjs`: Test connection against a stub server on 127.0.0.1.
- `test/portable.test.mjs`: importing the current config, export / import, masking, presets,
  and the agent definitions' own checks.
- `test/manifest.test.mjs`: the manifest, the third-party notices, the webview's CSP, and
  that nothing but Test connection uses the network.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would: the editor, presets, validation, Test connection, the diff
preview, the status bar, restore, import, terminals, export, Reload Window, and a second
window in Restricted Mode. `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point into a
temporary folder. Secret storage uses VS Code's basic store inside the throwaway profile
(`--password-store=basic`), so it never reaches your keyring. Test connection talks to a
stub server. VS Code runs headless. Linux only, with `code` on your `PATH` (or set
`VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
E2E_SHOTS=images npm run test:e2e   # also retakes the README screenshots
```

Screenshots of failing steps land in the temporary folder it prints.

## Adding a preset

Add it to the agent's file in `src/core/agents` (`presets`): field values and the key mode.
Link the provider's documentation in `docs`. `npm test` checks that every preset validates.

## Adding an agent

An agent is a data file in `src/core/agents`, listed in `src/core/defs.ts`. It holds:

- `config`: the file, its format (`json` or `toml`), the environment variable that moves its
  folder, and the default folder.
- `fields`: the form. Each field has a `target` key path, which may use `{field}`
  placeholders, a type, help text, validation, and `when` conditions.
- `secret`: how a key can reach the agent (`terminal`, `helper`, `dotenv`, `config`,
  `none`), with honest help text, and the credential keys to clear on every apply.
- `presets`, and optionally `test` for Test connection.

`checkAgentDef` reports mistakes (unknown placeholders, conditions on missing fields, a
plain-text mode not marked as such) and runs in the tests.

## Layout

| Path | |
| --- | --- |
| `src/core/agents/*.json` | Agent definitions |
| `src/core/defs.ts` | Loading and checking them |
| `src/core/profile.ts` | Conditions, presets, validation |
| `src/core/plan.ts` | What applying a profile changes |
| `src/core/edit.ts` | JSON and TOML edits that keep formatting |
| `src/core/files.ts`, `apply.ts` | Atomic writes, backups, `.env`, prepare / commit |
| `src/core/connection.ts` | Test connection |
| `src/core/portable.ts`, `mask.ts` | Import / export, masking |
| `src/service.ts` | Preview, apply, restore, import, terminals |
| `src/panel.ts`, `webview/` | The profiles editor |
| `src/statusBar.ts`, `src/extension.ts` | Status bar, commands |

`src/core` has no VS Code dependency and is what the unit tests load.

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
