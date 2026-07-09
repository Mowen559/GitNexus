/**
 * Single-file git history utilities.
 *
 * Backs the /api/file/history, /api/file/version, and /api/file/diff endpoints.
 * Mirrors the spawn-based, no-shell git invocation pattern used by git-clone.ts
 * to avoid command injection, and reuses the canonical path.relative containment
 * idiom for path-traversal protection.
 *
 * Security notes:
 *  - git is spawned with an argv array (never a shell string), so shell
 *    metacharacters in user input cannot inject commands.
 *  - Refs/commit-ishes are validated to reject option-injection (leading `-`)
 *    and any character outside the git ref-name safe set.
 *  - File paths are contained inside the repo root and converted to a posix
 *    pathspec passed after a `--` separator.
 */

import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../core/logger.js';
import { BadRequestError, ForbiddenError } from './validation.js';

/** Unit/record separators used to delimit `git log --format` fields safely. */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

/** Cap captured git stdout to avoid unbounded memory on huge files/diffs. */
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

export interface FileCommit {
  hash: string;
  author: string;
  email: string;
  date: string; // ISO-8601 (author date)
  message: string;
}

/**
 * Validate a git ref / commit-ish. Rejects option injection (leading `-`) and
 * any character outside the conservative ref-name safe set. Allows hex hashes,
 * branch/tag names, and ancestry suffixes (`~`, `^`).
 */
export function assertSafeRef(ref: string, name = 'ref'): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) {
    throw new BadRequestError(`Invalid ${name}`);
  }
  if (ref.startsWith('-')) {
    throw new BadRequestError(`Invalid ${name}`);
  }
  if (!/^[0-9A-Za-z._/~^-]+$/.test(ref)) {
    throw new BadRequestError(`Invalid ${name}`);
  }
  return ref;
}

/**
 * Verify a user-supplied file path stays inside the repo root and return a
 * posix-style relative pathspec (git wants forward slashes on every platform).
 */
export function assertContainedRelPath(repoPath: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new BadRequestError('Missing path');
  }
  if (filePath.includes('\0')) {
    throw new BadRequestError('Path must not contain null bytes');
  }
  const repoRoot = path.resolve(repoPath);
  const fullPath = path.resolve(repoRoot, filePath);
  const rel = path.relative(repoRoot, fullPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ForbiddenError('Path traversal denied');
  }
  return rel.split(path.sep).join('/');
}

export interface GitOptions {
  cwd: string;
  gitDir?: string;
  workTree?: string;
  encoding?: 'buffer' | 'utf-8';
}

/** Spawn git with an argv array and capture stdout (bounded). No shell. */
export function runGitCapture(
  args: string[],
  options: GitOptions & { encoding: 'buffer' },
): Promise<Buffer>;
export function runGitCapture(args: string[], options?: GitOptions | string): Promise<string>;
export function runGitCapture(
  args: string[],
  options: GitOptions | string = { cwd: process.cwd() },
): Promise<string | Buffer> {
  const cwd = typeof options === 'string' ? options : options.cwd;
  const gitDir = typeof options === 'string' ? undefined : options.gitDir;
  const workTree = typeof options === 'string' ? undefined : options.workTree;
  const encoding = typeof options === 'string' ? 'utf-8' : options.encoding || 'utf-8';

  const finalArgs = [...args];
  if (gitDir) finalArgs.unshift(`--git-dir=${gitDir}`);
  if (workTree) finalArgs.unshift(`--work-tree=${workTree}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('git', finalArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
      },
    });

    const chunks: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    let aborted = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        aborted = true;
        proc.kill();
        reject(new Error('git output too large'));
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('close', (code) => {
      if (aborted) return;
      if (code === 0) {
        const fullBuffer = Buffer.concat(chunks);
        resolve(encoding === 'buffer' ? fullBuffer : fullBuffer.toString('utf-8'));
      } else {
        // Log full stderr internally but don't leak it to API callers.
        if (stderr.trim()) logger.error(`git ${args[0]} stderr: ${stderr.trim()}`);
        reject(new Error(`git ${args[0]} failed (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      if (aborted) return;
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

/** Commit history for a single file (follows renames). */
export async function getFileHistory(
  repoPath: string,
  filePath: string,
  limit = 100,
): Promise<FileCommit[]> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const max = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
  const format = ['%H', '%an', '%ae', '%aI', '%s'].join(FIELD_SEP) + RECORD_SEP;

  const out = await runGitCapture(
    ['log', `--max-count=${max}`, '--follow', `--format=${format}`, '--', rel],
    path.resolve(repoPath),
  );

  const commits: FileCommit[] = [];
  for (const record of out.split(RECORD_SEP)) {
    const line = record.replace(/^\r?\n/, '');
    if (!line.trim()) continue;
    const parts = line.split(FIELD_SEP);
    const hash = parts[0]?.trim();
    if (!hash) continue;
    commits.push({
      hash,
      author: parts[1] ?? '',
      email: parts[2] ?? '',
      date: parts[3] ?? '',
      message: (parts[4] ?? '').trim(),
    });
  }
  return commits;
}

/** File content at a specific commit/ref (`git show <ref>:<path>`). */
export async function getFileVersion(
  repoPath: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const safeRef = assertSafeRef(ref);
  // safeRef cannot start with '-', so `${safeRef}:${rel}` is not an option flag.
  return runGitCapture(['show', `${safeRef}:${rel}`], path.resolve(repoPath));
}

/** Unified diff of a single file between two refs (`git diff <from> <to> -- <path>`). */
export async function getFileDiff(
  repoPath: string,
  filePath: string,
  from: string,
  to: string,
): Promise<string> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const safeFrom = assertSafeRef(from, 'from');
  const safeTo = assertSafeRef(to, 'to');
  return runGitCapture(['diff', safeFrom, safeTo, '--', rel], path.resolve(repoPath));
}
