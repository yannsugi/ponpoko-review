import * as vscode from 'vscode';
import * as path from 'path';

/**
 * パス判定の純粋関数置き場。markdown / comments / diffTree / extension で
 * 重複していた「配下判定」「最長一致 worktree」「outputDir 解決」をここに集約する。
 */

export interface IsUnderOptions {
  /** true なら dir 自身（fsPath === dir）は配下とみなさない。既定 false（自身を含む）。 */
  excludeSelf?: boolean;
}

/**
 * fsPath が dir 配下かどうか。前方一致ではなく path.relative で判定するので
 * `/repo/.ponpoko-review-x` を `/repo/.ponpoko-review` 配下と誤認しない。
 * 既定では dir 自身も配下に含める（worktree 所属判定用）。ツリーから出力物を除外する用途など
 * dir 自身を除きたいときは `{ excludeSelf: true }`。
 */
export function isUnder(dir: string, fsPath: string, opts: IsUnderOptions = {}): boolean {
  const rel = path.relative(dir, fsPath);
  if (opts.excludeSelf && rel === '') {
    return false;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * fsPath を含む worktree（`path` を持つもの）をパスの最長前方一致で求める（入れ子 worktree 対応）。
 * どれにも属さなければ undefined。
 */
export function owningWorktree<T extends { path: string }>(
  fsPath: string,
  worktrees: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const wt of worktrees) {
    if (isUnder(wt.path, fsPath) && (!best || wt.path.length > best.path.length)) {
      best = wt;
    }
  }
  return best;
}

/** owningWorktree のパス版。 */
export function owningWorktreePath(
  fsPath: string,
  worktrees: readonly { path: string }[],
): string | undefined {
  return owningWorktree(fsPath, worktrees)?.path;
}

/** outputDir 設定値を絶対パスに解決する（相対はワークスペースルート基準、絶対パスはそのまま）。 */
export function resolveOutputRoot(repoRoot: string, outputDir: string): string {
  return path.isAbsolute(outputDir) ? outputDir : path.join(repoRoot, outputDir);
}

/** 設定 `ponpokoReview.outputDir`（既定 `.ponpoko-review`）を読んで絶対パスに解決する。 */
export function configuredOutputRoot(repoRoot: string): string {
  const setting = vscode.workspace
    .getConfiguration('ponpokoReview')
    .get<string>('outputDir', '.ponpoko-review');
  return resolveOutputRoot(repoRoot, setting);
}
