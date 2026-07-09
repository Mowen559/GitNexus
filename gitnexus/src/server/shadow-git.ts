import path from 'path';
import fs from 'fs/promises';
import {
  runGitCapture,
  assertContainedRelPath,
  assertSafeRef,
  type FileCommit,
} from './git-history.js';
import { logger } from '../core/logger.js';

/** Unit/record separators used to delimit `git log --format` fields safely. */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

function getShadowGitOptions(repoPath: string) {
  const root = path.resolve(repoPath);
  return {
    cwd: root,
    gitDir: path.join(root, '.shadow-git'),
    workTree: root,
  };
}

/**
 * Ensures the .shadow-git directory exists and is initialized.
 * Also configures the post-commit hook in the main repository to auto-clear shadow-git.
 */
export async function initShadowGit(repoPath: string): Promise<void> {
  const root = path.resolve(repoPath);
  const shadowDir = path.join(root, '.shadow-git');

  try {
    const stat = await fs.stat(shadowDir);
    if (!stat.isDirectory()) {
      throw new Error('.shadow-git exists but is not a directory');
    }
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      logger.info(`Initializing Shadow Git at ${shadowDir}`);
      await runGitCapture(['init', '--bare', shadowDir], root);
    } else {
      throw e;
    }
  }

  // Install the post-commit hook in the main repository
  const hookDir = path.join(root, '.git', 'hooks');
  try {
    await fs.mkdir(hookDir, { recursive: true });
  } catch (e) {
    // ignore
  }

  const hookPath = path.join(hookDir, 'post-commit');
  const hookContent = `#!/bin/sh
# Automatically clear Shadow Git snapshots on official commit
SHADOW_DIR=".shadow-git"
if [ -d "$SHADOW_DIR" ]; then
  rm -rf "$SHADOW_DIR"
  git init --bare "$SHADOW_DIR" > /dev/null 2>&1
  echo "Shadow Git cleared."
fi
`;

  try {
    // Only write if it doesn't exist or doesn't have the shadow git clearing code
    let write = true;
    try {
      const existing = await fs.readFile(hookPath, 'utf8');
      if (existing.includes('SHADOW_DIR=".shadow-git"')) {
        write = false;
      }
    } catch (e) {}

    if (write) {
      await fs.appendFile(hookPath, '\n' + hookContent);
      // Make executable (only matters on unix, but harmless on windows)
      try {
        await fs.chmod(hookPath, 0o755);
      } catch (e) {}
      logger.info(`Installed Shadow Git auto-clear post-commit hook`);
    }
  } catch (e: any) {
    logger.error(`Failed to install post-commit hook: ${e.message}`);
  }
}

/**
 * Commits a specific file to the shadow git repository.
 */
export async function commitShadowChange(
  repoPath: string,
  filePath: string,
  message: string = 'Auto-snapshot',
  author: string = 'AI <ai@gitnexus>',
): Promise<void> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const options = getShadowGitOptions(repoPath);

  try {
    // First stage the file in shadow git
    await runGitCapture(['add', '--', rel], options);

    // Check if there are actually changes staged
    try {
      await runGitCapture(['diff', '--cached', '--quiet'], options);
      // If it exits with 0, there are NO changes
      return;
    } catch (e) {
      // If it exits with 1, there ARE changes (which is what we want)
    }

    // Commit the changes
    await runGitCapture(['commit', '-m', message, '--author', author], options);
    logger.info(`Saved shadow snapshot for ${filePath}`);
  } catch (e: any) {
    // Silently ignore if file doesn't exist or git fails
    logger.warn(`Failed to commit shadow change for ${filePath}: ${e.message}`);
  }
}

/**
 * Clears the shadow git repository entirely.
 */
export async function clearShadowGit(repoPath: string): Promise<void> {
  const root = path.resolve(repoPath);
  const shadowDir = path.join(root, '.shadow-git');
  try {
    await fs.rm(shadowDir, { recursive: true, force: true });
    await initShadowGit(repoPath);
    logger.info(`Cleared shadow git`);
  } catch (e: any) {
    logger.error(`Failed to clear shadow git: ${e.message}`);
  }
}

/**
 * Retrieves the commit history specifically from the shadow repository.
 */
export async function getShadowFileHistory(
  repoPath: string,
  filePath: string,
  limit = 100,
): Promise<FileCommit[]> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const max = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
  const format = ['%H', '%an', '%ae', '%aI', '%s'].join(FIELD_SEP) + RECORD_SEP;
  const options = getShadowGitOptions(repoPath);

  try {
    const out = await runGitCapture(
      ['log', `--max-count=${max}`, '--follow', `--format=${format}`, '--', rel],
      options,
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
  } catch (e) {
    return []; // Return empty history if shadow-git doesn't exist or no history
  }
}

/** File content at a specific commit/ref in shadow git */
export async function getShadowFileVersion(
  repoPath: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const safeRef = assertSafeRef(ref);
  const options = getShadowGitOptions(repoPath);
  return runGitCapture(['show', `${safeRef}:${rel}`], options);
}

/** Unified diff of a single file between two refs in shadow git */
export async function getShadowFileDiff(
  repoPath: string,
  filePath: string,
  from: string,
  to: string,
): Promise<string> {
  const rel = assertContainedRelPath(repoPath, filePath);
  const safeFrom = assertSafeRef(from, 'from');
  const safeTo = assertSafeRef(to, 'to');
  const options = getShadowGitOptions(repoPath);
  return runGitCapture(['diff', safeFrom, safeTo, '--', rel], options);
}
