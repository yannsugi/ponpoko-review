import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, FileStatus, Worktree, diffNameStatus, viewHash, worktreeList } from './git';
import { ViewedStore } from './viewed';

/** worktree のパスから表示用の名前（ベース名）を得る。 */
export function worktreeName(wt: Worktree): string {
  return path.basename(wt.path);
}

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

export type DiffNode = WorktreeNode | DirNode | FileNode;

const STATUS_ICON: Record<FileStatus, { icon: string; color: string }> = {
  A: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  M: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  D: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' },
  R: { icon: 'diff-renamed', color: 'gitDecoration.renamedResourceForeground' },
  C: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  T: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  U: { icon: 'diff-ignored', color: 'gitDecoration.conflictingResourceForeground' },
};

export class DiffTreeProvider implements vscode.TreeDataProvider<DiffNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiffNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private mode: ViewMode = 'list';
  /** refresh ごとに worktree の差分一覧をキャッシュ（dir 展開のたびに git を叩かないため）。 */
  private readonly cache = new Map<string, DiffEntry[]>();

  constructor(
    private readonly repoRoot: string,
    private readonly viewed: ViewedStore,
  ) {}

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
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

  /** 設定から比較基準ブランチを読む（既定: main）。 */
  getBase(): string {
    return vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('baseBranch', 'main');
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
      item.resourceUri = vscode.Uri.file(path.join(node.worktree.path, node.relDir));
      item.contextValue = 'ponpoko.dir';
      return item;
    }
    return this.fileItem(node);
  }

  private worktreeItem(node: WorktreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      worktreeName(node.worktree),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    // current = このworktreeのブランチ(変更元=git head), target = マージ先(=base)。
    const target = this.getBase();
    const current = node.worktree.detached
      ? `(detached ${node.worktree.head.slice(0, 7)})`
      : node.worktree.branch ?? '(no branch)';
    // 矢印はマージの向き（current を target に取り込む）。
    item.description = `current: ${current} → target: ${target}`;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.tooltip = new vscode.MarkdownString(
      `**${worktreeName(node.worktree)}**\n\n` +
        `current: \`${current}\`  （変更元 / git head）\n\n` +
        `target: \`${target}\`  （マージ先 / base）\n\n` +
        `${node.worktree.path}`,
    );
    item.contextValue = 'ponpoko.worktree';
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const { entry } = node;
    // tree モードはベース名、list モードはフルパスを表示。
    const label = this.mode === 'tree' ? entry.path.split('/').pop()! : entry.path;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const isViewed = this.viewed.isViewed(node.worktree.path, entry.path);
    const deco = STATUS_ICON[entry.status] ?? STATUS_ICON.M;
    item.iconPath = new vscode.ThemeIcon(
      deco.icon,
      new vscode.ThemeColor(isViewed ? 'disabledForeground' : deco.color),
    );
    item.description =
      (isViewed ? '✓ 表示済み · ' : '') +
      entry.status +
      (entry.oldPath ? ` ← ${entry.oldPath}` : '');
    item.tooltip = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
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
      try {
        const worktrees = await worktreeList(this.repoRoot);
        return worktrees.map((worktree) => ({ kind: 'worktree', worktree }));
      } catch (err) {
        vscode.window.showErrorMessage(`ponpoko-review: worktree 列挙に失敗: ${describe(err)}`);
        return [];
      }
    }

    if (node.kind === 'worktree') {
      const entries = await this.entriesFor(node.worktree);
      if (entries === null) {
        return [];
      }
      if (this.mode === 'list') {
        return [...entries]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((entry) => ({ kind: 'file', worktree: node.worktree, entry }));
      }
      return dirChildren(node.worktree, entries, '');
    }

    if (node.kind === 'dir') {
      const entries = await this.entriesFor(node.worktree);
      if (entries === null) {
        return [];
      }
      return dirChildren(node.worktree, entries, node.relDir);
    }

    return [];
  }

  /** worktree の差分一覧を取得（キャッシュ）。失敗時は null。viewed の再検証もここで一度だけ。 */
  private async entriesFor(worktree: Worktree): Promise<DiffEntry[] | null> {
    const key = worktree.path;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const base = this.getBase();
    try {
      const entries = await diffNameStatus(base, worktree.path);
      this.cache.set(key, entries);
      // viewed のうち、チェック時点から中身が変わったものは自動で外す。
      await Promise.all(
        entries.map((entry) => this.revalidateViewed(base, worktree, entry)),
      );
      return entries;
    } catch (err) {
      vscode.window.showErrorMessage(
        `ponpoko-review: diff 取得に失敗 (${worktreeName(worktree)}, base=${base}): ${describe(err)}`,
      );
      return null;
    }
  }

  /** viewed なファイルの現在ハッシュを取り直し、チェック時と違えば外す。 */
  private async revalidateViewed(base: string, worktree: Worktree, entry: DiffEntry): Promise<void> {
    if (!this.viewed.isViewed(worktree.path, entry.path)) {
      return;
    }
    try {
      const current = await viewHash(base, entry.path, worktree.path);
      if (current !== this.viewed.getHash(worktree.path, entry.path)) {
        await this.viewed.unsetViewed(worktree.path, entry.path);
      }
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
