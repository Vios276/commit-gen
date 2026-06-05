# Changelog

## 0.0.6

- Capture Codex's final message with `--output-last-message` to avoid CLI logs entering the commit input.

## 0.0.5

- Switch the default Codex model to `gpt-5.3-codex-spark`.
- Force low reasoning effort for default Codex commit-message generation.
- Replace the legacy unsupported `gpt-5.4-nano` Codex setting at runtime.

## 0.0.4

- Ignore legacy Codex approval args left in user or workspace settings.

## 0.0.3

- Change the Source Control input action icon to the Sparkle codicon.

## 0.0.2

- Remove the Codex CLI approval flag from the default args.
- Insert model options before the stdin prompt marker for better `codex exec` compatibility.

## 0.0.1

- Initial extension scaffold.
- Add Source Control input box generation command.
- Add Codex and Claude Code CLI provider settings.
