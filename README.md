# Commit Gen

Commit Gen is a VS Code extension that writes Conventional Commits-style commit messages into the Git Source Control input box. It generates messages from the current Git diff by calling either Codex CLI or Claude Code CLI.

## Features

- Adds a generate button to the right side of the Source Control input box through the proposed `scm/inputBox` contribution point.
- Uses the built-in Git extension API to write the generated message into the commit input.
- Supports Codex CLI by default and Claude Code CLI through settings.
- Passes a low-cost model explicitly instead of relying on each CLI's default model.
- Uses staged changes first by default, then falls back to working tree changes when nothing is staged.
- Prompts the CLI to return only a Conventional Commits message.

## Proposed API requirement

Commit Gen uses VS Code's proposed `contribSourceControlInputBoxMenu` API to place the action directly beside the Source Control input box. This gives the desired Copilot-style placement, but it is not suitable for normal Marketplace publication.

For local development, the included launch configuration already passes:

```sh
--enable-proposed-api local.commit-gen
```

For VSIX sharing, users must run VS Code Insiders with:

```sh
code-insiders . --enable-proposed-api=local.commit-gen
```

## Settings

Codex CLI:

```json
{
  "commitGen.provider": "codex",
  "commitGen.codexCommand": "codex",
  "commitGen.codexModel": "gpt-5.4-nano",
  "commitGen.codexArgs": [
    "exec",
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-"
  ]
}
```

Claude Code CLI:

```json
{
  "commitGen.provider": "claude",
  "commitGen.claudeCommand": "claude",
  "commitGen.claudeModel": "claude-haiku-4-5-20251001",
  "commitGen.claudeArgs": ["-p"]
}
```

Commit Gen automatically appends `--model <model>` to the selected CLI args. If your account or CLI does not support the default model, set `commitGen.codexModel` or `commitGen.claudeModel` to another lightweight model supported by your environment. Set the model value to an empty string only when you intentionally want to use the CLI's configured default.

Common options:

```json
{
  "commitGen.diffMode": "stagedOrWorkingTree",
  "commitGen.language": "en",
  "commitGen.includeBody": "auto"
}
```

If an argument contains `${prompt}`, Commit Gen replaces it with the generated prompt. Otherwise it sends the prompt to the CLI through stdin.

## Development

```sh
npm install
npm run compile
```

Press F5 in VS Code and run the `Run Extension` configuration.
