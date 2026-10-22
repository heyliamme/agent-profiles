# Security policy

The extension keeps API keys in VS Code's secret storage, writes the config files of
coding agents (Claude Code's `settings.json`, Codex's `config.toml` and `.env`, and key
files it creates), keeps backups of those files, and sends one request when you click
Test connection. Bugs that leak a key (into a file, log, notification, export, webview
or a request to another address), write outside the agents' config files and the
extension's own storage, replace or corrupt a config file, or let a workspace change your
user configuration in Restricted Mode are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/agent-profiles/security/advisories/new),
not public issues. Include steps to reproduce, and never include a real key. You should
hear back within a week.

## Scope

In scope: key disclosure, script execution or HTML injection in the webview from profile
or config content, writes to unexpected paths (through placeholders, symlinks or file
names), config files left broken or with unrelated keys changed, Test connection sending
the key anywhere other than the configured address, and anything that sends data off the
machine without a click on Test connection.

Out of scope: keys you chose to keep in plain text ("In settings.json", the key file or
`.env`) being readable by other programs running as you. That is the documented trade-off
of those options.
