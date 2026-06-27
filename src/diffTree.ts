import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, Worktree, diffNameStatus, viewHashes, worktreeList } from './git';
import { ViewedStore } from './viewed';
import { WorktreeBaseStore } from './worktreeBase';

/** worktree のパスから表示用の名前（ベース名）を得る。 */
export function worktreeName(wt: Worktree): string {
  return path.basename(wt.path);
}

/** status 文字アイコン(media/status/<s>.svg)を持つ status 集合。 */
const STATUS_ICON_KEYS = new Set(['a', 'm', 'd', 'r', 'c', 't', 'u']);

export type ViewMode = 'list' | 'tree';

export interface WorktreeNode {
  kind: 'worktree';
  worktree: Worktree;
}

export interface DirNode {
  kind: 'dir';
  worktree: Worktree;
  /** worktree ルートからの相対ディレクトリ（圧縮済みのこともある、例 "src/handlers"）。 */
  relDir: string;
  /** 表示ラベル（親ディレクトリより下の部分）。 */
  label: string;
}

export interface FileNode {
  kind: 'file';
  worktree: Worktree;
  entry: DiffEntry;
}

export interface CommentInfo {
  line: number; // 0-based 開始行
  endLine: number; // 0-based 終了行
  text: string;
}

export interface CommentNode {
  kind: 'comment';
  worktree: Worktree;
  uri: vscode.Uri;
  info: CommentInfo;
}

export interface MessageNode {
  kind: 'message';
  label: string;
}

export type DiffNode = WorktreeNode | DirNode | FileNode | CommentNode | MessageNode;

export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiffNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private mode: ViewMode = 'list';
  private commentsOnly = false;
  private showComments = true;
  /** refresh ごとに worktree の差分一覧をキャッシュ（dir 展開のたびに git を叩かないため）。 */
  private readonly cache = new Map<string, DiffEntry[]>();

  constructor(
    private readonly repoRoot: string,
    private readonly viewed: ViewedStore,
    private readonly baseStore: WorktreeBaseStore,
    /** ファイル(fsPath)に付いているコメント一覧を返す。 */
    private readonly commentsOf: (fsPath: string) => CommentInfo[],
    /** ディレクトリ配下のコメント数（フォルダ/worktree 集計用）。 */
    private readonly commentCountUnder: (dirPath: string) => number,
    /** 拡張のルート uri（status 文字アイコンの解決用）。 */
    private readonly extensionUri: vscode.Uri,
  ) {}

  /** status 文字アイコン(A/M/D/R…)の uri。viewed はグレーの -dim 版。 */
  private statusIcon(status: string, viewed: boolean): vscode.Uri {
    const k = (status || 'M').toLowerCase();
    const key = STATUS_ICON_KEYS.has(k) ? k : 'm';
    return vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'status',
      `${key}${viewed ? '-dim' : ''}.svg`,
    );
  }

  /** 差分データから取り直す全更新（git diff 再実行）。保存・base変更時など。 */
  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * キャッシュを保持したまま再描画のみ（git を叩かない）。
   * チェック(viewed)やコメント数など、差分データが変わらない更新用。ちらつき防止。
   */
  softRefresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getShowComments(): boolean {
    return this.showComments;
  }

  /** ツリー上のコメント表示（子ノード・💬・フォルダ集計）をまとめてON/OFF。 */
  setShowComments(on: boolean): void {
    if (this.showComments !== on) {
      this.showComments = on;
      this._onDidChangeTreeData.fire();
    }
  }

  getCommentsOnly(): boolean {
    return this.commentsOnly;
  }

  /** コメントのあるファイルだけに絞り込む（list/tree と直交するフィルタ）。 */
  setCommentsOnly(on: boolean): void {
    if (this.commentsOnly !== on) {
      this.commentsOnly = on;
      this._onDidChangeTreeData.fire();
    }
  }

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this._onDidChangeTreeData.fire();
    }
  }

  /** グローバル設定の比較基準ブランチ（既定: main）。 */
  getGlobalBase(): string {
    return vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('baseBranch', 'main');
  }

  /**
   * 比較基準(base/target)ブランチを返す。
   * worktreePath を渡すとその worktree の上書きを優先し、無ければグローバル設定。
   */
  getBase(worktreePath?: string): string {
    if (worktreePath) {
      const override = this.baseStore.get(worktreePath);
      if (override) {
        return override;
      }
    }
    return this.getGlobalBase();
  }

  /** その worktree が個別 base を上書きしているか。 */
  hasBaseOverride(worktreePath: string): boolean {
    return this.baseStore.get(worktreePath) !== undefined;
  }

  /** 作業ファイル uri から FileNode を解決する（コメントジャンプ用）。差分に無ければ null。 */
  async resolveFileNode(uri: vscode.Uri): Promise<FileNode | null> {
    let worktrees: Worktree[];
    try {
      worktrees = await worktreeList(this.repoRoot);
    } catch {
      return null;
    }
    let owner: Worktree | undefined;
    for (const wt of worktrees) {
      const rel = path.relative(wt.path, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (!owner || wt.path.length > owner.path.length) {
          owner = wt;
        }
      }
    }
    if (!owner) {
      return null;
    }
    const entries =
      this.cache.get(owner.path) ?? (await this.entriesFor(owner)) ?? [];
    const rel = path.relative(owner.path, uri.fsPath).split(path.sep).join('/');
    const entry = entries.find((e) => e.path === rel);
    return entry ? { kind: 'file', worktree: owner, entry } : null;
  }

  /** キャッシュ済み差分から、relDir 配下の全ファイルを返す（チェック伝播用）。 */
  filesUnder(worktree: Worktree, relDir: string): DiffEntry[] {
    const entries = this.cache.get(worktree.path) ?? [];
    const prefix = relDir + '/';
    return entries.filter((e) => e.path.startsWith(prefix));
  }

  getTreeItem(node: DiffNode): vscode.TreeItem {
    if (node.kind === 'worktree') {
      return this.worktreeItem(node);
    }
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'ponpoko.dir';
      // 配下のコメント数を集計表示（畳んでいても分かる）。フォルダ自体のコメントと
      // 誤読しないよう「配下合計」と明記。有無表示なので常時。
      const cc = this.commentCountUnder(path.join(node.worktree.path, node.relDir));
      if (cc > 0) {
        item.description = `💬${cc}（配下合計）`;
      }
      // 配下ファイルが全て viewed ならフォルダも checked。
      const files = this.filesUnder(node.worktree, node.relDir);
      const allViewed =
        files.length > 0 &&
        files.every((e) => this.viewed.isViewed(node.worktree.path, e.path));
      item.checkboxState = allViewed
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    }
    if (node.kind === 'comment') {
      return this.commentItem(node);
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    return this.fileItem(node);
  }

  private commentItem(node: CommentNode): vscode.TreeItem {
    const { info } = node;
    const ref =
      info.endLine > info.line ? `${info.line + 1}-${info.endLine + 1}` : `${info.line + 1}`;
    const first = info.text.split('\n')[0] || '(空コメント)';
    const item = new vscode.TreeItem(first, vscode.TreeItemCollapsibleState.None);
    item.description = `:${ref}`;
    item.iconPath = new vscode.ThemeIcon('comment');
    item.tooltip = new vscode.MarkdownString(info.text);
    item.contextValue = 'ponpoko.comment';
    item.command = {
      command: 'ponpokoReview.openComment',
      title: 'Open Comment',
      arguments: [{ uri: node.uri, line: info.line }],
    };
    return item;
  }

  private worktreeItem(node: WorktreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      worktreeName(node.worktree),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    // current = このworktreeのブランチ(変更元=git head), target = マージ先(=base)。
    const target = this.getBase(node.worktree.path);
    const overridden = this.hasBaseOverride(node.worktree.path);
    const current = node.worktree.detached
      ? `(detached ${node.worktree.head.slice(0, 7)})`
      : node.worktree.branch ?? '(no branch)';
    // 矢印はマージの向き（current を target に取り込む）。上書き時は ★、コメントは 💬N。
    const cc = this.commentCountUnder(node.worktree.path);
    item.description =
      `current: ${current} → target: ${target}` +
      (overridden ? ' ★' : '') +
      (cc > 0 ? `   💬${cc}（配下合計）` : '');
    item.iconPath = new vscode.ThemeIcon('repo');
    item.tooltip = new vscode.MarkdownString(
      `**${worktreeName(node.worktree)}**\n\n` +
        `current: \`${current}\`  （変更元 / git head）\n\n` +
        `target: \`${target}\`  （マージ先 / base${overridden ? '・このworktree個別設定 ★' : '・グローバル設定'}）\n\n` +
        `${node.worktree.path}`,
    );
    item.contextValue = 'ponpoko.worktree';
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { entry } = node;
    const fsPath = path.join(node.worktree.path, entry.path);
    // 💬（有無/件数）は常時表示。子ノード展開は showComments のときだけ。
    const comments = this.commentsOf(fsPath);
    // tree モードはベース名、list モードはフルパスを表示。
    const label = this.mode === 'tree' ? entry.path.split('/').pop()! : entry.path;
    const item = new vscode.TreeItem(
      label,
      this.showComments && comments.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const isViewed = this.viewed.isViewed(node.worktree.path, entry.path);
    // status を表す文字アイコン(A/M/D/R…)。viewed はグレー。
    item.iconPath = this.statusIcon(entry.status, isViewed);
    // description はコメント💬とリネーム元のみ。
    const parts: string[] = [];
    if (comments.length > 0) {
      parts.push(`💬${comments.length}`);
    }
    if (entry.oldPath) {
      parts.push(`← ${entry.oldPath}`);
    }
    item.description = parts.join('  ');
    item.tooltip = new vscode.MarkdownString(
      `${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path}\n\n` +
        `status: \`${entry.status}\`` +
        (comments.length > 0 ? ` ・ 💬 コメント ${comments.length} 件` : ''),
    );
    item.contextValue = 'ponpoko.file';
    item.checkboxState = isViewed
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: 'ponpokoReview.openDiff',
      title: 'Open Diff',
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: DiffNode): Promise<DiffNode[]> {
    if (!node) {
      let worktrees: Worktree[];
      try {
        worktrees = await worktreeList(this.repoRoot);
      } catch (err) {
        vscode.window.showErrorMessage(`ponpoko-review: worktree 列挙に失敗: ${describe(err)}`);
        return [];
      }
      let nodes: DiffNode[] = worktrees.map((worktree) => ({ kind: 'worktree', worktree }));
      if (this.commentsOnly) {
        // コメントのある worktree だけ残す。
        nodes = nodes.filter(
          (n) => n.kind === 'worktree' && this.commentCountUnder(n.worktree.path) > 0,
        );
        if (nodes.length === 0) {
          return [{ kind: 'message', label: 'コメントはありません' }];
        }
      }
      return nodes;
    }

    if (node.kind === 'worktree') {
      const entries = await this.visibleEntries(node.worktree);
      if (entries === null) {
        return [];
      }
      const children: DiffNode[] =
        this.mode === 'list'
          ? [...entries]
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
              .map((entry) => ({ kind: 'file', worktree: node.worktree, entry }))
          : dirChildren(node.worktree, entries, '');
      const empty = this.commentsOnly ? 'コメントなし' : '差分なし';
      return children.length > 0 ? children : [{ kind: 'message', label: empty }];
    }

    if (node.kind === 'dir') {
      const entries = await this.visibleEntries(node.worktree);
      if (entries === null) {
        return [];
      }
      return dirChildren(node.worktree, entries, node.relDir);
    }

    if (node.kind === 'file') {
      if (!this.showComments) {
        return [];
      }
      // ファイルの子＝そのファイルのコメント。
      const fsPath = path.join(node.worktree.path, node.entry.path);
      const uri = vscode.Uri.file(fsPath);
      return this.commentsOf(fsPath).map((info) => ({
        kind: 'comment',
        worktree: node.worktree,
        uri,
        info,
      }));
    }

    return [];
  }

  /** 表示対象の差分一覧。commentsOnly のときはコメントのあるファイルだけに絞る。 */
  private async visibleEntries(worktree: Worktree): Promise<DiffEntry[] | null> {
    const entries = await this.entriesFor(worktree);
    if (entries === null || !this.commentsOnly) {
      return entries;
    }
    return entries.filter(
      (e) => this.commentsOf(path.join(worktree.path, e.path)).length > 0,
    );
  }

  /** worktree の差分一覧を取得（キャッシュ）。失敗時は null。viewed の再検証もここで一度だけ。 */
  private async entriesFor(worktree: Worktree): Promise<DiffEntry[] | null> {
    const key = worktree.path;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const base = this.getBase(worktree.path);
    try {
      const entries = await diffNameStatus(base, worktree.path);
      this.cache.set(key, entries);
      // viewed のうち、チェック時点から中身が変わったものは自動で外す（バッチ）。
      await this.revalidateViewed(base, worktree, entries);
      return entries;
    } catch (err) {
      vscode.window.showErrorMessage(
        `ponpoko-review: diff 取得に失敗 (${worktreeName(worktree)}, base=${base}): ${describe(err)}`,
      );
      return null;
    }
  }

  /** viewed なファイルの現在ハッシュをバッチで取り直し、チェック時と違えば外す。 */
  private async revalidateViewed(base: string, worktree: Worktree, entries: DiffEntry[]): Promise<void> {
    const viewedPaths = entries
      .filter((e) => this.viewed.isViewed(worktree.path, e.path))
      .map((e) => e.path);
    if (viewedPaths.length === 0) {
      return;
    }
    try {
      const hashes = await viewHashes(base, viewedPaths, worktree.path);
      await Promise.all(
        viewedPaths.map(async (p) => {
          if (hashes.get(p) !== this.viewed.getHash(worktree.path, p)) {
            await this.viewed.unsetViewed(worktree.path, p);
          }
        }),
      );
    } catch {
      // ハッシュ取得失敗時は viewed を維持（誤って外さない）。
    }
  }
}

/** dir 直下の子（サブディレクトリ＋ファイル）を返す。単一子フォルダは圧縮する。 */
export function dirChildren(
  worktree: Worktree,
  entries: DiffEntry[],
  dir: string,
): DiffNode[] {
  const prefix = dir === '' ? '' : dir + '/';
  const subdirs = new Set<string>();
  const files: DiffEntry[] = [];
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) {
      continue;
    }
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(e);
    } else {
      subdirs.add(prefix + rest.slice(0, slash));
    }
  }

  const dirNodes: DirNode[] = [...subdirs]
    .sort()
    .map((d) => {
      const full = compactDir(entries, d);
      return {
        kind: 'dir',
        worktree,
        relDir: full,
        label: full.slice(prefix.length),
      };
    });

  const fileNodes: FileNode[] = files
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({ kind: 'file', worktree, entry }));

  // フォルダ先、ファイル後（GitHub/Explorer 流）。
  return [...dirNodes, ...fileNodes];
}

/** ディレクトリ直下がサブフォルダ1つだけ（ファイル無し）なら下まで連結（src/handlers のように圧縮）。 */
export function compactDir(entries: DiffEntry[], dir: string): string {
  let cur = dir;
  for (;;) {
    const prefix = cur + '/';
    const subdirs = new Set<string>();
    let hasFile = false;
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) {
        continue;
      }
      const rest = e.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        hasFile = true;
      } else {
        subdirs.add(prefix + rest.slice(0, slash));
      }
    }
    if (!hasFile && subdirs.size === 1) {
      cur = [...subdirs][0];
    } else {
      return cur;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
