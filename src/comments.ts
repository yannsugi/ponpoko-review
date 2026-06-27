import * as vscode from 'vscode';
import * as path from 'path';

let commentSeq = 0;

/** 1コメント = 1修正指示。 */
class ReviewComment implements vscode.Comment {
  id: number;
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation = { name: 'ponpoko-review' };
  contextValue = 'canEdit'; // メニューの when 句用
  savedBody: string | vscode.MarkdownString;

  constructor(
    text: string,
    public parent?: vscode.CommentThread,
  ) {
    this.id = ++commentSeq;
    this.body = new vscode.MarkdownString(text);
    this.savedBody = this.body;
  }
}

/**
 * diff エディタの行にレビューコメント（修正指示）スレッドを立てて保持する。
 *
 * ★最重要: コメントは右(HEAD側=file スキーム)の実ファイルにのみ付ける。
 *   commentingRangeProvider が file スキームだけを許可することで担保する。
 *   left(base 側)に付くと行番号が base 基準でズレる。
 */
interface SavedThread {
  uri: string;
  line: number;
  /** 範囲コメントの終端行(0-based, 生の range.end.line)。単一行は省略可。 */
  endLine?: number;
  comments: string[];
  resolved?: boolean;
}

const STORAGE_KEY = 'ponpoko.comments';

export class CommentStore implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Set<vscode.CommentThread>();

  constructor(private readonly state: vscode.Memento) {
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
    this.restore();
  }

  /** workspaceState から保存済みコメントを復元する。 */
  private restore(): void {
    const saved = this.state.get<SavedThread[]>(STORAGE_KEY, []);
    for (const s of saved) {
      if (!s.uri || !s.comments?.length) {
        continue;
      }
      const range = new vscode.Range(s.line, 0, s.endLine ?? s.line, 0);
      const thread = this.controller.createCommentThread(vscode.Uri.parse(s.uri), range, []);
      thread.comments = s.comments.map((t) => new ReviewComment(t, thread));
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.state = s.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      this.threads.add(thread);
    }
  }

  /** 現在の全スレッドを workspaceState に保存する（ローカル永続化）。 */
  private persist(): void {
    const saved: SavedThread[] = [];
    for (const t of this.threads) {
      if (t.comments.length === 0) {
        continue;
      }
      saved.push({
        uri: t.uri.toString(),
        line: t.range?.start.line ?? 0,
        endLine: t.range?.end.line ?? t.range?.start.line ?? 0,
        comments: t.comments.map((c) =>
          typeof c.body === 'string' ? c.body : c.body.value,
        ),
        resolved: t.state === vscode.CommentThreadState.Resolved,
      });
    }
    void this.state.update(STORAGE_KEY, saved);
  }

  /** コメント widget の Submit から呼ばれる。スレッドへコメントを追加する。 */
  addComment(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    thread.comments = [...thread.comments, new ReviewComment(reply.text, thread)];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.threads.add(thread);
    this.persist();
  }

  /** コメントを編集モードにする。 */
  editComment(comment: vscode.Comment): void {
    const c = comment as ReviewComment;
    const thread = c.parent;
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.map((cm) => {
      if ((cm as ReviewComment).id === c.id) {
        cm.mode = vscode.CommentMode.Editing;
      }
      return cm;
    });
  }

  /** 編集内容を確定する。 */
  saveComment(comment: vscode.Comment): void {
    const c = comment as ReviewComment;
    const thread = c.parent;
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.map((cm) => {
      if ((cm as ReviewComment).id === c.id) {
        (cm as ReviewComment).savedBody = cm.body;
        cm.mode = vscode.CommentMode.Preview;
      }
      return cm;
    });
    this.persist();
  }

  /** 編集をキャンセルして元の本文に戻す。 */
  cancelEdit(comment: vscode.Comment): void {
    const c = comment as ReviewComment;
    const thread = c.parent;
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.map((cm) => {
      if ((cm as ReviewComment).id === c.id) {
        cm.body = (cm as ReviewComment).savedBody;
        cm.mode = vscode.CommentMode.Preview;
      }
      return cm;
    });
  }

  /** 1コメントを削除する（スレッドが空になれば破棄）。 */
  deleteComment(comment: vscode.Comment): void {
    const c = comment as ReviewComment;
    const thread = c.parent;
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.filter((cm) => (cm as ReviewComment).id !== c.id);
    if (thread.comments.length === 0) {
      thread.dispose();
      this.threads.delete(thread);
    }
    this.persist();
  }

  /** スレッドの Resolve / Unresolve を切り替える。 */
  toggleResolve(thread: vscode.CommentThread): void {
    thread.state =
      thread.state === vscode.CommentThreadState.Resolved
        ? vscode.CommentThreadState.Unresolved
        : vscode.CommentThreadState.Resolved;
    this.persist();
  }

  /** 保持中の全スレッドを返す（md 書き出し用）。 */
  getThreads(): vscode.CommentThread[] {
    return [...this.threads];
  }

  /** 指定 worktree 配下のスレッドだけ返す（md 書き出し用）。 */
  getThreadsUnder(worktreePath: string): vscode.CommentThread[] {
    return [...this.threads].filter((t) => isUnderPath(worktreePath, t.uri.fsPath));
  }

  /** 指定ディレクトリ配下のコメント数（フォルダ/worktree 集計用）。 */
  countUnder(dirPath: string): number {
    return this.getThreadsUnder(dirPath).length;
  }

  /** 保持中のコメント総数。 */
  total(): number {
    return this.threads.size;
  }

  /** 指定ファイル(uri.fsPath)に付いているコメントの一覧（行範囲＋本文）。行順。 */
  listFor(fsPath: string): { line: number; endLine: number; text: string }[] {
    const res: { line: number; endLine: number; text: string }[] = [];
    for (const t of this.threads) {
      if (t.uri.fsPath === fsPath && t.comments.length > 0) {
        const r = threadLineRange(t);
        res.push({ line: r.start, endLine: r.end, text: threadText(t) });
      }
    }
    res.sort((a, b) => a.line - b.line);
    return res;
  }

  /** 全スレッドを破棄する（Clear）。永続化もクリア。 */
  clear(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads.clear();
    this.persist();
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
    if (n > 0) {
      this.persist();
    }
    return n;
  }

  dispose(): void {
    // 永続化は残す（再起動で復元するため）。UI スレッドのみ破棄。
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads.clear();
    this.controller.dispose();
  }
}

/** fsPath が dir 配下かどうか。 */
function isUnderPath(dir: string, fsPath: string): boolean {
  const rel = path.relative(dir, fsPath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * スレッドの行範囲(0-based, end は含む行)を返す。
 * 複数行選択で終端が次行頭(character 0)になっている場合は1行戻して、見た目の選択行に合わせる。
 */
export function threadLineRange(thread: vscode.CommentThread): { start: number; end: number } {
  const r = thread.range;
  if (!r) {
    return { start: 0, end: 0 };
  }
  let end = r.end.line;
  if (end > r.start.line && r.end.character === 0) {
    end -= 1;
  }
  return { start: r.start.line, end: Math.max(end, r.start.line) };
}

/** スレッドのコメント本文を結合して1つのテキストにする。 */
export function threadText(thread: vscode.CommentThread): string {
  return thread.comments
    .map((c) => (typeof c.body === 'string' ? c.body : c.body.value))
    .join('\n\n')
    .trim();
}
