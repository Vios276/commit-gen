import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type CliProvider = 'codex' | 'claude';
type DiffMode = 'staged' | 'stagedOrWorkingTree' | 'workingTree';
type IncludeBody = 'auto' | 'never' | 'always';

interface CommitGenConfig {
  provider: CliProvider;
  command: string;
  model: string;
  args: string[];
  diffMode: DiffMode;
  language: string;
  includeBody: IncludeBody;
  maxDiffChars: number;
  timeoutMs: number;
  customInstructions: string;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
}

interface Repository {
  rootUri: vscode.Uri;
  inputBox: {
    value: string;
  };
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

const output = vscode.window.createOutputChannel('Commit Gen');
const conventionalHeaderPattern = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .+/i;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('commitGen.generateCommitMessage', generateCommitMessage)
  );
}

export function deactivate(): void {
  // No resources to dispose beyond extension subscriptions.
}

async function generateCommitMessage(): Promise<void> {
  try {
    const config = readConfig();
    const repository = await pickRepository();
    const rootPath = repository.rootUri.fsPath;
    const currentMessage = repository.inputBox.value.trim();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: 'Generating commit message...',
        cancellable: false
      },
      async () => {
        const gitContext = await buildGitContext(rootPath, config.diffMode, config.maxDiffChars);
        const prompt = buildPrompt(gitContext, currentMessage, config);
        const rawMessage = await runSelectedCli(config, rootPath, prompt);
        const message = extractCommitMessage(rawMessage);

        if (!message) {
          throw new Error('The CLI returned an empty commit message.');
        }

        repository.inputBox.value = message;

        if (!isConventionalHeader(message)) {
          output.appendLine('Generated message did not match the Conventional Commits header pattern.');
          vscode.window.showWarningMessage('Commit Gen inserted the message, but its first line does not look like Conventional Commits.');
          return;
        }

        vscode.window.showInformationMessage('Commit message generated.');
      }
    );
  } catch (error) {
    const message = getErrorMessage(error);
    output.appendLine(`[error] ${message}`);
    vscode.window.showErrorMessage(`Commit Gen: ${message}`);
  }
}

function readConfig(): CommitGenConfig {
  const config = vscode.workspace.getConfiguration('commitGen');
  const provider = config.get<CliProvider>('provider', 'codex');
  const command = provider === 'claude'
    ? config.get<string>('claudeCommand', 'claude')
    : config.get<string>('codexCommand', 'codex');
  const rawModel = provider === 'claude'
    ? config.get<string>('claudeModel', 'claude-haiku-4-5-20251001')
    : config.get<string>('codexModel', 'gpt-5.3-codex-spark');
  const model = provider === 'codex' ? normalizeCodexModel(rawModel) : rawModel;
  const rawArgs = provider === 'claude'
    ? config.get<string[]>('claudeArgs', ['-p'])
    : config.get<string[]>('codexArgs', [
      'exec',
      '-c',
      'model_reasoning_effort="low"',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '-'
    ]);
  const args = provider === 'codex'
    ? ensureCodexLowReasoningArgs(removeLegacyCodexArgs(rawArgs))
    : rawArgs;

  return {
    provider,
    command,
    model,
    args,
    diffMode: config.get<DiffMode>('diffMode', 'stagedOrWorkingTree'),
    language: config.get<string>('language', 'en'),
    includeBody: config.get<IncludeBody>('includeBody', 'auto'),
    maxDiffChars: config.get<number>('maxDiffChars', 12000),
    timeoutMs: config.get<number>('timeoutMs', 120000),
    customInstructions: config.get<string>('customInstructions', '')
  };
}

function normalizeCodexModel(model: string): string {
  if (model.trim() === 'gpt-5.4-nano') {
    return 'gpt-5.3-codex-spark';
  }

  return model;
}

function removeLegacyCodexArgs(args: string[]): string[] {
  const sanitized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--ask-for-approval' || arg === '-a') {
      const nextArg = args[index + 1];

      if (nextArg && !nextArg.startsWith('-')) {
        index += 1;
      }

      continue;
    }

    if (arg.startsWith('--ask-for-approval=') || arg.startsWith('-a=')) {
      continue;
    }

    sanitized.push(arg);
  }

  return sanitized;
}

function ensureCodexLowReasoningArgs(args: string[]): string[] {
  if (hasCodexReasoningArg(args)) {
    return args;
  }

  return insertBeforePromptMarker(args, ['-c', 'model_reasoning_effort="low"']);
}

function hasCodexReasoningArg(args: string[]): boolean {
  return args.some((arg, index) => (
    arg.includes('model_reasoning_effort')
    || arg.includes('reasoning_effort')
    || (index > 0 && (args[index - 1] === '-c' || args[index - 1] === '--config') && arg.includes('reasoning'))
  ));
}

async function pickRepository(): Promise<Repository> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

  if (!gitExtension) {
    throw new Error('The built-in Git extension is not available.');
  }

  const git = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  const api = git.getAPI(1);

  if (api.repositories.length === 0) {
    throw new Error('Open a folder with a Git repository before generating a commit message.');
  }

  if (api.repositories.length === 1) {
    return api.repositories[0];
  }

  const selected = await vscode.window.showQuickPick(
    api.repositories.map((repository) => ({
      label: vscode.workspace.asRelativePath(repository.rootUri, false),
      description: repository.rootUri.fsPath,
      repository
    })),
    {
      placeHolder: 'Select a Git repository'
    }
  );

  if (!selected) {
    throw new Error('No Git repository selected.');
  }

  return selected.repository;
}

async function buildGitContext(rootPath: string, diffMode: DiffMode, maxChars: number): Promise<string> {
  const status = (await runGit(rootPath, ['status', '--short'])).trim();

  if (!status) {
    throw new Error('No Git changes found.');
  }

  const stagedDiff = await runGit(rootPath, ['diff', '--cached', '--no-ext-diff', '--minimal']);
  const unstagedDiff = await runGit(rootPath, ['diff', '--no-ext-diff', '--minimal']);
  const sections: string[] = [`## git status --short\n${status}`];

  if (diffMode === 'staged') {
    if (!stagedDiff.trim()) {
      throw new Error('No staged changes found. Stage changes or switch commitGen.diffMode.');
    }

    sections.push(`## staged diff\n${stagedDiff.trimEnd()}`);
    return truncate(sections.join('\n\n'), maxChars);
  }

  if (diffMode === 'stagedOrWorkingTree' && stagedDiff.trim()) {
    sections.push(`## staged diff\n${stagedDiff.trimEnd()}`);
    return truncate(sections.join('\n\n'), maxChars);
  }

  if (stagedDiff.trim()) {
    sections.push(`## staged diff\n${stagedDiff.trimEnd()}`);
  }

  if (unstagedDiff.trim()) {
    sections.push(`## unstaged diff\n${unstagedDiff.trimEnd()}`);
  }

  const remainingChars = Math.max(1000, maxChars - sections.join('\n\n').length);
  const untrackedSummary = await summarizeUntrackedFiles(rootPath, remainingChars);

  if (untrackedSummary) {
    sections.push(`## untracked files\n${untrackedSummary}`);
  }

  if (sections.length === 1) {
    throw new Error('No staged, unstaged, or readable untracked changes found.');
  }

  return truncate(sections.join('\n\n'), maxChars);
}

async function summarizeUntrackedFiles(rootPath: string, maxChars: number): Promise<string> {
  const raw = await runGit(rootPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = raw.split('\0').filter(Boolean);

  if (files.length === 0) {
    return '';
  }

  const root = path.resolve(rootPath);
  const sections: string[] = [];
  let remaining = maxChars;

  for (const file of files.slice(0, 20)) {
    if (remaining <= 0) {
      break;
    }

    const resolved = path.resolve(rootPath, file);

    if (!resolved.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    try {
      const stat = await fs.stat(resolved);

      if (!stat.isFile()) {
        continue;
      }

      const buffer = await fs.readFile(resolved);

      if (buffer.includes(0)) {
        sections.push(`### ${file}\n[binary file omitted]`);
        remaining -= sections[sections.length - 1].length;
        continue;
      }

      const text = buffer.toString('utf8');
      const snippet = truncate(text, Math.min(remaining, 4000));
      const section = `### ${file}\n${snippet}`;
      sections.push(section);
      remaining -= section.length;
    } catch (error) {
      sections.push(`### ${file}\n[unable to read file: ${getErrorMessage(error)}]`);
    }
  }

  if (files.length > 20) {
    sections.push(`[${files.length - 20} additional untracked files omitted]`);
  }

  return sections.join('\n\n');
}

function buildPrompt(gitContext: string, currentMessage: string, config: CommitGenConfig): string {
  const bodyInstruction = config.includeBody === 'never'
    ? 'Return a single-line commit message only.'
    : config.includeBody === 'always'
      ? 'Include a concise body after a blank line.'
      : 'Include a body only when it adds important context.';

  const existingMessage = currentMessage
    ? `\nExisting commit input, if useful as intent:\n${currentMessage}\n`
    : '';
  const customInstructions = config.customInstructions.trim()
    ? `\nAdditional user instructions:\n${config.customInstructions.trim()}\n`
    : '';

  return [
    'You generate Git commit messages.',
    'Return only the commit message. Do not include Markdown fences, labels, alternatives, explanations, or commentary.',
    'Follow Conventional Commits exactly: type(scope)!: subject.',
    'Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    'Use an optional scope only when the diff makes the scope obvious.',
    'Use "!" and a BREAKING CHANGE footer only when the diff proves a breaking change.',
    'Keep the subject imperative, specific, and at most 72 characters. Do not end it with a period.',
    `Write the commit message in this language: ${config.language}.`,
    bodyInstruction,
    existingMessage,
    customInstructions,
    'Git context:',
    gitContext
  ].join('\n');
}

async function runSelectedCli(config: CommitGenConfig, cwd: string, prompt: string): Promise<string> {
  const outputFile = shouldCaptureCodexLastMessage(config)
    ? path.join(os.tmpdir(), `commit-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    : undefined;
  const processArgs = outputFile
    ? insertBeforePromptMarker(addModelArgs(config.args, config.model), ['--output-last-message', outputFile])
    : addModelArgs(config.args, config.model);
  const { args, stdin } = materializePrompt(processArgs, prompt, config.model);
  output.appendLine(`Running ${config.provider} provider: ${config.command} ${args.join(' ')}`);

  try {
    const result = await runProcess(config.command, args, cwd, stdin, config.timeoutMs, 1024 * 1024);

    if (result.stderr.trim()) {
      output.appendLine(result.stderr.trim());
    }

    if (outputFile) {
      const lastMessage = await fs.readFile(outputFile, 'utf8');

      if (lastMessage.trim()) {
        return lastMessage;
      }
    }

    return result.stdout;
  } finally {
    if (outputFile) {
      await fs.rm(outputFile, { force: true });
    }
  }
}

function shouldCaptureCodexLastMessage(config: CommitGenConfig): boolean {
  return config.provider === 'codex' && !hasOutputLastMessageArg(config.args);
}

function hasOutputLastMessageArg(args: string[]): boolean {
  return args.some((arg, index) => (
    arg === '--output-last-message'
    || arg === '-o'
    || arg.startsWith('--output-last-message=')
    || (index > 0 && (args[index - 1] === '--output-last-message' || args[index - 1] === '-o'))
  ));
}

function addModelArgs(args: string[], model: string): string[] {
  const trimmedModel = model.trim();

  if (!trimmedModel || hasModelArg(args)) {
    return args;
  }

  return insertBeforePromptMarker(args, ['--model', trimmedModel]);
}

function hasModelArg(args: string[]): boolean {
  return args.some((arg, index) => (
    arg === '--model'
    || arg === '-m'
    || arg.startsWith('--model=')
    || arg.includes('${model}')
    || (index > 0 && (args[index - 1] === '--model' || args[index - 1] === '-m'))
  ));
}

function insertBeforePromptMarker(args: string[], insertedArgs: string[]): string[] {
  const promptMarkerIndex = args.findIndex((arg) => arg === '-' || arg.includes('${prompt}'));

  if (promptMarkerIndex === -1) {
    return [...args, ...insertedArgs];
  }

  return [
    ...args.slice(0, promptMarkerIndex),
    ...insertedArgs,
    ...args.slice(promptMarkerIndex)
  ];
}

function materializePrompt(args: string[], prompt: string, model: string): { args: string[]; stdin: string } {
  let usedPromptPlaceholder = false;
  const materializedArgs = args.map((arg) => {
    const withModel = arg.replaceAll('${model}', model.trim());

    if (!withModel.includes('${prompt}')) {
      return withModel;
    }

    usedPromptPlaceholder = true;
    return withModel.replaceAll('${prompt}', prompt);
  });

  return {
    args: materializedArgs,
    stdin: usedPromptPlaceholder ? '' : prompt
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, cwd, '', 15000, 5 * 1024 * 1024);
  return result.stdout;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        return;
      }

      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;

      if (stderrBytes <= maxOutputBytes) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        return;
      }

      if (stdoutBytes > maxOutputBytes) {
        reject(new Error(`${command} produced more than ${maxOutputBytes} bytes of output.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}: ${stderr.trim() || stdout.trim()}`));
        return;
      }

      resolve({ stdout, stderr });
    });

    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

function extractCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  text = text.replace(/^```(?:\w+)?\s*\n/, '').replace(/\n```$/, '').trim();
  text = text.replace(/^commit message:\s*/i, '').trim();

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  const lines = text.split('\n');
  const conventionalStart = lines.findIndex((line) => conventionalHeaderPattern.test(line.trim()));

  if (conventionalStart > 0) {
    text = lines.slice(conventionalStart).join('\n').trim();
  }

  return text;
}

function isConventionalHeader(message: string): boolean {
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  return conventionalHeaderPattern.test(firstLine);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
