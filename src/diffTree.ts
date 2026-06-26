import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, FileStatus, Worktree, diffNameStatus, viewHash, worktreeList } from './git';
import { ViewedStore } from './viewed';

/** worktree のパスから表示用の名前（ベース名）を得る。 */
export function worktreeName(wt: Worktree): string {
  return path.basename(wt.path);
}

export interface WorktreeNode {
  kind: 'worktree';
  worktree: Worktree;
}

export interface FileNode {
  kind: 'file';
  worktree: Worktree;
  entry: DiffEntry;
}

export type DiffNode = WorktreeNode | FileNode;

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

  constructor(
    private readonly repoRoot: string,
    private readonly viewed: ViewedStore,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** 設定から比較基準ブランチを読む（既定: main）。 */
  getBase(): string {
    return vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('baseBranch', 'main');
  }

  getTreeItem(node: DiffNode): vscode.TreeItem {
    if (node.kind === 'worktree') {
      const item = new vscode.TreeItem(
        worktreeName(node.worktree),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const base = this.getBase();
      const head = node.worktree.detached
        ? `(detached ${node.worktree.head.slice(0, 7)})`
        : node.worktree.branch ?? '(no branch)';
      // 何のブランチと何のブランチを比較しているか（base...そのworktreeのブランチ）。
      item.description = `${base}...${head}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = new vscode.MarkdownString(
        `**${worktreeName(node.worktree)}**\n\n` +
          `比較: \`${base}\` ... \`${head}\`\n\n` +
          `${node.worktree.path}`,
      );
      item.contextValue = 'ponpoko.worktree';
      return item;
    }

    const { entry } = node;
    const item = new vscode.TreeItem(
      entry.path,
      vscode.TreeItemCollapsibleState.None,
    );
    const isViewed = this.viewed.isViewed(node.worktree.path, entry.path);
    const deco = STATUS_ICON[entry.status] ?? STATUS_ICON.M;
    // viewed は淡色化して de-emphasize する。
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
      const base = this.getBase();
      try {
        const entries = await diffNameStatus(base, node.worktree.path);
        const nodes: FileNode[] = entries.map((entry) => ({
          kind: 'file',
          worktree: node.worktree,
          entry,
        }));
        // viewed のうち、チェック時点から中身が変わったものは自動で外す。
        await Promise.all(
          nodes.map((n) => this.revalidateViewed(base, n)),
        );
        return nodes;
      } catch (err) {
        vscode.window.showErrorMessage(
          `ponpoko-review: diff 取得に失敗 (${worktreeName(node.worktree)}, base=${base}): ${describe(err)}`,
        );
        return [];
      }
    }

    return [];
  }

  /** viewed なファイルの現在ハッシュを取り直し、チェック時と違えば外す。 */
  private async revalidateViewed(base: string, node: FileNode): Promise<void> {
    const { worktree, entry } = node;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
