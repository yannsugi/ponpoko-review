import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEntry, FileStatus, Worktree, diffNameStatus, worktreeList } from './git';

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

  constructor(private readonly repoRoot: string) {}

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
      item.description = node.worktree.detached
        ? '(detached)'
        : node.worktree.branch ?? '';
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = node.worktree.path;
      item.contextValue = 'ponpoko.worktree';
      return item;
    }

    const { entry } = node;
    const item = new vscode.TreeItem(
      entry.path,
      vscode.TreeItemCollapsibleState.None,
    );
    const deco = STATUS_ICON[entry.status] ?? STATUS_ICON.M;
    item.iconPath = new vscode.ThemeIcon(deco.icon, new vscode.ThemeColor(deco.color));
    item.description = entry.status + (entry.oldPath ? ` ← ${entry.oldPath}` : '');
    item.tooltip = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
    item.contextValue = 'ponpoko.file';
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
        vscode.window.showErrorMessage(`ぽんぽこ: worktree 列挙に失敗: ${describe(err)}`);
        return [];
      }
    }

    if (node.kind === 'worktree') {
      const base = this.getBase();
      try {
        const entries = await diffNameStatus(base, node.worktree.path);
        return entries.map((entry) => ({
          kind: 'file',
          worktree: node.worktree,
          entry,
        }));
      } catch (err) {
        vscode.window.showErrorMessage(
          `ぽんぽこ: diff 取得に失敗 (${worktreeName(node.worktree)}, base=${base}): ${describe(err)}`,
        );
        return [];
      }
    }

    return [];
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
