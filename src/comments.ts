import * as vscode from 'vscode';
import { isUnder } from './paths';

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
  /** 開始行(0-based)。ファイル全体へのコメント（range 無し）は undefined。 */
  line?: number;
  /** 範囲コメントの終端行(0-based, 生の range.end.line)。単一行は省略可。 */
  endLine?: number;
  /** アンカー行（開始行）のテキスト(trim済)。再アンカー(行ズレ追従)用。 */
  anchor?: string;
  comments: string[];
  resolved?: boolean;
}

const STORAGE_KEY = 'ponpoko.comments';
const DRIFT_LABEL = '⚠ 行がずれている可能性があります';

export class CommentStore implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Set<vscode.CommentThread>();
  /** thread → アンカー行テキスト。 */
  private readonly anchors = new WeakMap<vscode.CommentThread, string>();

  constructor(private readonly state: vscode.Memento) {
    this.controller = vscode.comments.createCommentController(
      'ponpokoReview',
      'ponpoko-review',
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document): vscode.CommentingRanges => {
        // 右(作業ツリーの実ファイル=file スキーム)だけコメント可能にする。
        // 行コメントに加えて、ファイル全体へのコメント（range 無し）も許可する。
        if (document.uri.scheme !== 'file') {
          return { ranges: [], enableFileComments: false };
        }
        const last = Math.max(document.lineCount - 1, 0);
        return { ranges: [new vscode.Range(0, 0, last, 0)], enableFileComments: true };
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
      // line 無し＝ファイル全体へのコメント（range 無しで復元）。
      const range =
        s.line === undefined ? undefined : new vscode.Range(s.line, 0, s.endLine ?? s.line, 0);
      const thread = this.createThread(vscode.Uri.parse(s.uri), range);
      thread.comments = s.comments.map((t) => new ReviewComment(t, thread));
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.state = s.resolved
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
      if (s.anchor) {
        this.anchors.set(thread, s.anchor);
      }
      this.threads.add(thread);
    }
  }

  /**
   * スレッドを作る。range 無しはファイル全体へのコメント。
   * （型定義上 createCommentThread の range は Range だが、実行時は undefined を受け付け、
   *   CommentThread.range も `Range | undefined`。）
   */
  private createThread(uri: vscode.Uri, range: vscode.Range | undefined): vscode.CommentThread {
    return this.controller.createCommentThread(uri, range as vscode.Range, []);
  }

  /**
   * 復元したコメントを、保存したアンカー行テキストと現在のファイル内容で照合し、
   * 行がズレていたら近傍を探して追従させる。見つからなければ警告ラベルを付ける。
   * （ファイル読み込みが必要なので非同期。activate から呼ぶ）
   */
  async reanchor(): Promise<void> {
    for (const thread of [...this.threads]) {
      const anchor = this.anchors.get(thread);
      const r = thread.range;
      if (!anchor || !r) {
        continue;
      }
      let lines: string[];
      try {
        const buf = await vscode.workspace.fs.readFile(thread.uri);
        lines = Buffer.from(buf).toString('utf8').split(/\r?\n/);
      } catch {
        continue; // ファイルが無い等はそのまま
      }
      if (lines[r.start.line]?.trim() === anchor) {
        thread.label = undefined;
        continue;
      }
      // 近傍(±50行)で一致する行を探す
      const span = r.end.line - r.start.line;
      let found = -1;
      for (let d = 1; d <= 50 && found < 0; d++) {
        if (lines[r.start.line - d]?.trim() === anchor) {
          found = r.start.line - d;
        } else if (lines[r.start.line + d]?.trim() === anchor) {
          found = r.start.line + d;
        }
      }
      if (found >= 0) {
        thread.range = new vscode.Range(found, 0, found + span, 0);
        thread.label = undefined;
      } else {
        thread.label = DRIFT_LABEL;
      }
    }
  }

  /** 開いているドキュメントから指定行のテキスト(trim)を得る（アンカー用）。 */
  private anchorTextFor(uri: vscode.Uri, line: number): string | undefined {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString(),
    );
    if (!doc || line >= doc.lineCount) {
      return undefined;
    }
    const t = doc.lineAt(line).text.trim();
    return t.length > 0 ? t : undefined;
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
        line: t.range?.start.line,
        endLine: t.range?.end.line,
        anchor: this.anchors.get(t),
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
    // アンカー行テキストを記録（再起動後の行ズレ追従用）。
    if (!this.anchors.has(thread) && thread.range) {
      const a = this.anchorTextFor(thread.uri, thread.range.start.line);
      if (a) {
        this.anchors.set(thread, a);
      }
    }
    this.threads.add(thread);
    this.persist();
  }

  /**
   * ファイル全体へのコメント（range 無しスレッド）を追加する。
   * 差分の有無を問わず、作業ツリーの実ファイル(file スキーム)に付ける（不変条件 1）。
   */
  addFileComment(uri: vscode.Uri, text: string): void {
    const body = text.trim();
    if (!body || uri.scheme !== 'file') {
      return;
    }
    const thread = this.createThread(uri, undefined);
    thread.comments = [new ReviewComment(body, thread)];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.state = vscode.CommentThreadState.Unresolved;
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

  /** 複数スレッドをまとめて Resolve 済みにする（Submit 後のループ閉鎖用）。 */
  resolveThreads(threads: vscode.CommentThread[]): void {
    for (const t of threads) {
      t.state = vscode.CommentThreadState.Resolved;
    }
    this.persist();
  }

  /** 複数スレッドをまとめて削除する（Submit 後の clear 用）。 */
  removeThreads(threads: vscode.CommentThread[]): void {
    for (const t of threads) {
      t.dispose();
      this.threads.delete(t);
    }
    this.persist();
  }

  /** 保持中の全スレッドを返す（md 書き出し用）。 */
  getThreads(): vscode.CommentThread[] {
    return [...this.threads];
  }

  /** 指定 worktree 配下のスレッドだけ返す（md 書き出し用）。 */
  getThreadsUnder(worktreePath: string): vscode.CommentThread[] {
    return [...this.threads].filter((t) => isUnder(worktreePath, t.uri.fsPath));
  }

  /** 指定ディレクトリ配下の未解決コメント数（フォルダ/worktree 集計用）。 */
  countUnder(dirPath: string): number {
    return this.getThreadsUnder(dirPath).filter(isActive).length;
  }

  /** 保持中の全スレッド数（Resolve済み含む。Clear 用）。 */
  total(): number {
    return this.threads.size;
  }

  /** 未解決（出力対象）のコメント数。ステータスバー用。 */
  activeCount(): number {
    return [...this.threads].filter(isActive).length;
  }

  /**
   * 指定ファイル(uri.fsPath)の未解決コメント一覧（行範囲＋本文＋行ズレ）。
   * ファイル全体へのコメント（line 無し）を先頭に、以降は行順。
   */
  listFor(fsPath: string): CommentEntry[] {
    const res: CommentEntry[] = [];
    for (const t of this.threads) {
      if (t.uri.fsPath === fsPath && t.comments.length > 0 && isActive(t)) {
        const r = threadLineRange(t);
        res.push({
          line: r?.start,
          endLine: r?.end,
          text: threadText(t),
          drifted: t.label === DRIFT_LABEL,
        });
      }
    }
    res.sort((a, b) => (a.line ?? -1) - (b.line ?? -1));
    return res;
  }

  /**
   * 指定ディレクトリ配下で未解決コメントを持つファイルの fsPath 一覧（重複なし）。
   * 差分に無いファイルをツリーに合流させるために使う。
   */
  filesWithComments(dirPath: string): string[] {
    const set = new Set<string>();
    for (const t of this.getThreadsUnder(dirPath)) {
      if (t.comments.length > 0 && isActive(t)) {
        set.add(t.uri.fsPath);
      }
    }
    return [...set];
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
      if (isUnder(worktreePath, thread.uri.fsPath)) {
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

/** ツリー表示用のコメント要約。line/endLine 無し＝ファイル全体へのコメント。 */
export interface CommentEntry {
  line?: number;
  endLine?: number;
  text: string;
  drifted: boolean;
}

/** ファイル全体へのコメント（range 無しスレッド）か。 */
export function isFileThread(thread: vscode.CommentThread): boolean {
  return !thread.range;
}

/** 未解決（出力対象）スレッドか。Resolve 済みは false。 */
function isActive(t: vscode.CommentThread): boolean {
  return t.state !== vscode.CommentThreadState.Resolved;
}

/**
 * スレッドの行範囲(0-based, end は含む行)を返す。ファイル全体へのコメント（range 無し）は undefined。
 * 複数行選択で終端が次行頭(character 0)になっている場合は1行戻して、見た目の選択行に合わせる。
 */
export function threadLineRange(
  thread: vscode.CommentThread,
): { start: number; end: number } | undefined {
  const r = thread.range;
  if (!r) {
    return undefined;
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
