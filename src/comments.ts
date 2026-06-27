import * as vscode from 'vscode';
import * as path from 'path';

/** 1コメント = 1修正指示。 */
class ReviewComment implements vscode.Comment {
  body: vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: 'ponpoko-review' };

  constructor(text: string) {
    this.body = new vscode.MarkdownString(text);
  }
}

/**
 * diff エディタの行にレビューコメント（修正指示）スレッドを立てて保持する。
 *
 * ★最重要: コメントは右(HEAD側=file スキーム)の実ファイルにのみ付ける。
 *   commentingRangeProvider が file スキームだけを許可することで担保する。
 *   left(base 側)に付くと行番号が base 基準でズレる。
 */
export class CommentStore implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Set<vscode.CommentThread>();

  constructor() {
    this.controller = vscode.comments.createCommentController(
      'ponpokoReview',
      'ponpoko-review',
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        // 右(作業ツリーの実ファイル=file スキーム)だけコメント可能にする。
        if (document.uri.scheme !== 'file') {
          return [];
        }
        const last = Math.max(document.lineCount - 1, 0);
        return [new vscode.Range(0, 0, last, 0)];
      },
    };
  }

  /** コメント widget の Submit から呼ばれる。スレッドへコメントを追加する。 */
  addComment(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    thread.comments = [...thread.comments, new ReviewComment(reply.text)];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.threads.add(thread);
  }

  /** 保持中の全スレッドを返す（md 書き出し用）。 */
  getThreads(): vscode.CommentThread[] {
    return [...this.threads];
  }

  /** 指定 worktree 配下のスレッドだけ返す（md 書き出し用）。 */
  getThreadsUnder(worktreePath: string): vscode.CommentThread[] {
    return [...this.threads].filter((t) => isUnderPath(worktreePath, t.uri.fsPath));
  }

  /** 全スレッドを破棄する（Clear）。 */
  clear(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads.clear();
  }

  /** 指定 worktree 配下のスレッドだけ破棄する。破棄した数を返す。 */
  clearUnder(worktreePath: string): number {
    let n = 0;
    for (const thread of [...this.threads]) {
      if (isUnderPath(worktreePath, thread.uri.fsPath)) {
        thread.dispose();
        this.threads.delete(thread);
        n++;
      }
    }
    return n;
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}

/** fsPath が dir 配下かどうか。 */
function isUnderPath(dir: string, fsPath: string): boolean {
  const rel = path.relative(dir, fsPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** スレッドのコメント本文を結合して1つのテキストにする。 */
export function threadText(thread: vscode.CommentThread): string {
  return thread.comments
    .map((c) => (typeof c.body === 'string' ? c.body : c.body.value))
    .join('\n\n')
    .trim();
}
