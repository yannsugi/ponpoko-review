import * as vscode from 'vscode';
import * as path from 'path';
import { Worktree } from './git';
import { threadText } from './comments';
import { worktreeName } from './diffTree';

interface ReviewItem {
  relpath: string;
  line: number; // 1-based (HEAD 基準)
  body: string;
}

export interface WriteResult {
  /** 書き出した review.md の絶対パス一覧。 */
  files: string[];
  /** 書き出したコメント(スレッド)総数。 */
  itemCount: number;
}

/** fsPath が dir 配下かどうか。 */
export function isUnder(dir: string, fsPath: string): boolean {
  const rel = path.relative(dir, fsPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** uri を所有する worktree を、パスの最長前方一致で求める。 */
function owningWorktree(fsPath: string, worktrees: Worktree[]): Worktree | undefined {
  let best: Worktree | undefined;
  for (const wt of worktrees) {
    const rel = path.relative(wt.path, fsPath);
    // wt 配下なら rel は '..' で始まらず、絶対パスにもならない。
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (!best || wt.path.length > best.path.length) {
        best = wt;
      }
    }
  }
  return best;
}

/**
 * 全コメントスレッドを worktree 単位にまとめ、
 * `<outputRoot>/<worktree-name>/review.md` に書き出す。
 *
 * 見出しは `path:line (base...HEAD)` 形式。スレッドは right(file) uri 前提なので
 * line は HEAD 基準でそのまま使える。
 */
export async function writeReview(opts: {
  outputRoot: string;
  base: string;
  threads: vscode.CommentThread[];
  worktrees: Worktree[];
}): Promise<WriteResult> {
  const { outputRoot, base, threads, worktrees } = opts;

  // worktree 名 → レビュー項目
  const grouped = new Map<string, ReviewItem[]>();
  let itemCount = 0;

  for (const thread of threads) {
    const body = threadText(thread);
    if (!body) {
      continue;
    }
    const fsPath = thread.uri.fsPath;
    const wt = owningWorktree(fsPath, worktrees);
    const name = wt ? worktreeName(wt) : 'unknown';
    const relpath = wt
      ? path.relative(wt.path, fsPath).split(path.sep).join('/')
      : fsPath;
    const line = (thread.range?.start.line ?? 0) + 1; // 0-based → 1-based

    const list = grouped.get(name) ?? [];
    list.push({ relpath, line, body });
    grouped.set(name, list);
    itemCount++;
  }

  const files: string[] = [];

  for (const [name, items] of grouped) {
    items.sort((a, b) => (a.relpath === b.relpath ? a.line - b.line : a.relpath < b.relpath ? -1 : 1));

    const md = renderMarkdown(name, base, items);
    const dir = vscode.Uri.file(path.join(outputRoot, name));
    const file = vscode.Uri.joinPath(dir, 'review.md');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(md, 'utf8'));
    files.push(file.fsPath);
  }

  return { files, itemCount };
}

/** 1 worktree 分の review.md 本文を組み立てる。 */
export function renderMarkdown(name: string, base: string, items: ReviewItem[]): string {
  const lines: string[] = [`# Review Instructions (${name})`, ''];
  for (const item of items) {
    lines.push(`## ${item.relpath}:${item.line} (${base}...HEAD)`);
    lines.push(item.body);
    lines.push('');
  }
  return lines.join('\n');
}
