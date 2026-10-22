# Changelog

## 0.1.0

First release.

- Profiles for Claude Code and Codex CLI: provider address, how the key is sent, models,
  reasoning settings, extra headers and environment variables, timeouts and retries, in a
  form with help for every field and validation (addresses, numbers, required fields,
  keys typed into the wrong field).
- Presets: Anthropic (sign in or API key), OpenRouter, Anthropic-compatible gateway,
  DeepSeek, Kimi, Z.ai, Amazon Bedrock and Google Vertex AI for Claude Code; OpenAI (sign
  in or API key), OpenRouter, Azure OpenAI, OpenAI-compatible gateway and Ollama for
  Codex. Presets only fill in the form.
- Applying writes `settings.json` (or the project's `.claude/settings.local.json`) and
  `config.toml`, honouring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Only the keys a profile
  manages change. What the previous profile wrote is taken back, and comments,
  formatting and every other key are kept.
- Keys live in VS Code's secret storage. Per profile, the agent reads them from VS Code
  terminals only (nothing on disk), a 600 key file through `apiKeyHelper` (Claude Code), a
  600 `$CODEX_HOME/.env` (Codex), or the config file in plain text. The form marks which
  is which.
- Every write is previewed as a diff with keys masked and needs an explicit Apply. Files
  are backed up first (last 10 per file) and written atomically, keeping permissions and
  symlinks. A file changed while the preview was open is not overwritten. **Restore
  Previous Config** puts back any backup, after a diff.
- Test connection: one request to the configured endpoint (models list, or a one-token
  request), with status, latency and the models found; redirects are not followed.
- Status bar item per agent with the active profile and model; click to switch. Workspace
  default profiles are suggested when the workspace opens, never applied silently.
- Import the current config as a profile (offering to keep a key it finds in secret
  storage), and export or import profiles as JSON without keys.
- Restricted Mode: profiles apply to user settings only. Runs on the remote side in
  Remote, WSL and containers.
- A project file that receives a key in plain text is kept out of Git
  (`.git/info/exclude`), and project files are never written through symlinks.
- Test connection checks the key even where the models list is public (OpenRouter), and
  only tests the fields the profile actually uses. A model alias such as `opus` is tested
  as the model it is set to resolve to.
- Saving a new key for the active profile offers to apply it when the key is on disk
  (config, key file or `.env`); renaming it doesn't ask to apply.
- Restore also removes the key file or `.env` line of the apply it undoes, brings back the
  one the restored config uses, and stays off project files in Restricted Mode.
- A credential header in Extra request headers is refused, not imported or exported, and
  masked in previews. Codex's key variable can't be PATH, HOME, LD_PRELOAD and the like.
  "No key here" keeps a custom provider's `env_key` for a key your shell exports.
- The external-change warning only looks at the keys a profile manages.
