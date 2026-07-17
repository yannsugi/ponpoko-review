import * as vscode from 'vscode';
import * as path from 'path';
import { Worktree } from './git';
import { threadLineRange, threadText } from './comments';
import { worktreeName } from './diffTree';

interface ReviewItem {
  relpath: string;
  line: number; // 1-based 開始行（HEAD 基準）
  endLine: number; // 1-based 終了行（単一行なら line と同じ）
  code?: string; // コメント対象行のコード（文脈）
  body: string;
}

export interface WriteResult {
  /** 書き出した review.md の絶対パス一覧。 */
  files: string[];
  /** 書き出したコメント(スレッド)総数。 */
  itemCount: number;
}

/**
 * timestamp 付き履歴ファイル名（例: review-20260716-143005.md）。
 * review.md は毎回上書きされるため、同内容をこの名前でも残して履歴にする。
 * 「最新」を指す固定パス(review.md)は claude -p や openReview 用に維持する。
 */
export function timestampedName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `review-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`
  );
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
  /** worktree パスごとに base(target)ブランチを解決する。 */
  resolveBase: (worktreePath: string) => string;
  threads: vscode.CommentThread[];
  worktrees: Worktree[];
  /** true: 全worktreeを1ファイル(<outputRoot>/review.md)にまとめる。false: worktree毎に分割。 */
  combined?: boolean;
}): Promise<WriteResult> {
  const { outputRoot, resolveBase, threads, worktrees, combined = false } = opts;

  // worktree 名 → { worktree, レビュー項目 }
  const grouped = new Map<string, { wt?: Worktree; items: ReviewItem[] }>();
  let itemCount = 0;

  // ファイル内容を一度だけ読む（コード文脈の抽出用）。
  const lineCache = new Map<string, string[]>();
  const getLines = async (uri: vscode.Uri): Promise<string[]> => {
    const key = uri.toString();
    let lines = lineCache.get(key);
    if (!lines) {
      try {
        lines = Buffer.from(await vscode.workspace.fs.readFile(uri))
          .toString('utf8')
          .split(/\r?\n/);
      } catch {
        lines = [];
      }
      lineCache.set(key, lines);
    }
    return lines;
  };

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
    const range = threadLineRange(thread); // 0-based, end含む
    const line = range.start + 1; // 0-based → 1-based
    const endLine = range.end + 1;
    // コメント対象行のコードを文脈として抽出。
    const lines = await getLines(thread.uri);
    const code = lines.slice(range.start, range.end + 1).join('\n') || undefined;

    const group = grouped.get(name) ?? { wt, items: [] };
    group.items.push({ relpath, line, endLine, code, body });
    grouped.set(name, group);
    itemCount++;
  }

  const sortItems = (items: ReviewItem[]) =>
    items.sort((a, b) => (a.relpath === b.relpath ? a.line - b.line : a.relpath < b.relpath ? -1 : 1));

  const files: string[] = [];
  // 同一 Submit 内は全ファイル同じ timestamp（1回の書き出し＝1世代）。
  const stamp = timestampedName(new Date());
  // review.md（最新・固定パス）と timestamp 付き履歴の二本立てで書く。
  // files には固定パスだけ入れる（呼び出し側が「最新」として開く）。
  const writeBoth = async (dir: vscode.Uri, md: string): Promise<void> => {
    const buf = Buffer.from(md, 'utf8');
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, 'review.md');
    await vscode.workspace.fs.writeFile(file, buf);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, stamp), buf);
    files.push(file.fsPath);
  };

  if (combined) {
    // 全worktreeを1ファイルにまとめる（<outputRoot>/review.md）。
    const sections: string[] = [];
    for (const [name, { wt, items }] of grouped) {
      sortItems(items);
      const base = wt ? resolveBase(wt.path) : resolveBase('');
      sections.push(renderMarkdown(name, base, items));
    }
    await writeBoth(vscode.Uri.file(outputRoot), sections.join('\n'));
    return { files, itemCount };
  }

  // worktree毎に分割（<outputRoot>/<worktree名>/review.md）。
  for (const [name, { wt, items }] of grouped) {
    sortItems(items);
    const base = wt ? resolveBase(wt.path) : resolveBase('');
    const md = renderMarkdown(name, base, items);
    await writeBoth(vscode.Uri.file(path.join(outputRoot, name)), md);
  }

  return { files, itemCount };
}

/** 1 worktree 分の review.md 本文を組み立てる。 */
export function renderMarkdown(name: string, base: string, items: ReviewItem[]): string {
  const lines: string[] = [`# Review Instructions (${name})`, ''];
  for (const item of items) {
    // 複数行選択は path:開始-終了、単一行は path:行。
    const ref = item.endLine > item.line ? `${item.line}-${item.endLine}` : `${item.line}`;
    lines.push(`## ${item.relpath}:${ref} (${base}...HEAD)`);
    // 対象コードを ``` フェンスで文脈として添える（行ズレに強く、Claudeが文脈を掴める）。
    if (item.code) {
      const lang = path.extname(item.relpath).slice(1);
      lines.push('```' + lang);
      lines.push(item.code);
      lines.push('```');
    }
    lines.push(item.body);
    lines.push('');
  }
  return lines.join('\n');
}
