import * as vscode from 'vscode';
import * as path from 'path';
import { listBranches, viewHash, worktreeList, Worktree } from './git';
import { DiffNode, DiffTreeProvider, WorktreeNode, worktreeName } from './diffTree';
import { BASE_SCHEME, BaseContentProvider } from './baseContentProvider';
import { openDiff } from './openDiff';
import { CommentStore } from './comments';
import { writeReview } from './markdown';
import { ViewedStore } from './viewed';
import { WorktreeBaseStore } from './worktreeBase';

export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) {
    vscode.window.showWarningMessage('ponpoko-review: ワークスペースが開かれていません。');
    return;
  }

  // 出力先（相対はワークスペースルート基準、絶対パスも可）。
  const resolveOutputRoot = (): string => {
    const setting = vscode.workspace
      .getConfiguration('ponpokoReview')
      .get<string>('outputDir', '.ponpoko-review');
    return path.isAbsolute(setting) ? setting : path.join(repoRoot, setting);
  };

  // コメント群を md に書き出す共通処理。
  const runSubmit = async (
    threads: vscode.CommentThread[],
    worktrees: Worktree[],
    emptyLabel: string,
  ): Promise<void> => {
    if (threads.length === 0) {
      vscode.window.showWarningMessage(`ponpoko-review: ${emptyLabel}コメントがありません。`);
      return;
    }
    try {
      const result = await writeReview({
        outputRoot: resolveOutputRoot(),
        resolveBase: (wtPath) => treeProvider.getBase(wtPath),
        threads,
        worktrees,
      });
      const choice = await vscode.window.showInformationMessage(
        `ponpoko-review: ${result.itemCount} 件を ${result.files.length} ファイルに書き出しました。`,
        '開く',
      );
      if (choice === '開く' && result.files.length > 0) {
        const doc = await vscode.workspace.openTextDocument(result.files[0]);
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `ponpoko-review: 書き出しに失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // base 側仮想ドキュメントのプロバイダ
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BASE_SCHEME,
      new BaseContentProvider(),
    ),
  );

  // コメント保持
  const store = new CommentStore();
  context.subscriptions.push(store);

  // "Viewed" 永続化ストア
  const viewed = new ViewedStore(context.workspaceState);
  // worktree ごとの比較先(base)上書きストア
  const baseStore = new WorktreeBaseStore(context.workspaceState);

  // 差分ツリー
  const treeProvider = new DiffTreeProvider(repoRoot, viewed, baseStore);
  const treeView = vscode.window.createTreeView('ponpokoReview.diffTree', {
    treeDataProvider: treeProvider,
    // フォルダ↔ファイルの伝播は viewed ストアを正として自前で管理する。
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(treeView);

  // 表示モード（list/tree）切替。メニューの when 句用に context key を同期。
  const syncViewMode = () =>
    vscode.commands.executeCommand('setContext', 'ponpokoReview.viewMode', treeProvider.getMode());
  syncViewMode();
  context.subscriptions.push(
    vscode.commands.registerCommand('ponpokoReview.viewAsTree', () => {
      treeProvider.setMode('tree');
      syncViewMode();
    }),
    vscode.commands.registerCommand('ponpokoReview.viewAsList', () => {
      treeProvider.setMode('list');
      syncViewMode();
    }),
  );

  // 1ファイルを viewed にする（現在の差分ハッシュを記録）。
  const markViewed = async (worktree: { path: string }, filePath: string): Promise<void> => {
    const base = treeProvider.getBase(worktree.path);
    try {
      const hash = await viewHash(base, filePath, worktree.path);
      await viewed.setViewed(worktree.path, filePath, hash);
    } catch {
      // ハッシュ取得失敗時はマークしない。
    }
  };

  // チェックボックス操作 → viewed の保存/解除。
  // フォルダをチェックすると配下ファイルを一括 viewed/解除（逆も getTreeItem 側で集計）。
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        if (node.kind === 'file') {
          if (checked) {
            await markViewed(node.worktree, node.entry.path);
          } else {
            await viewed.unsetViewed(node.worktree.path, node.entry.path);
          }
        } else if (node.kind === 'dir') {
          const files = treeProvider.filesUnder(node.worktree, node.relDir);
          await Promise.all(
            files.map((entry) =>
              checked
                ? markViewed(node.worktree, entry.path)
                : viewed.unsetViewed(node.worktree.path, entry.path),
            ),
          );
        }
      }
      treeProvider.refresh();
    }),
  );

  // ファイル保存で差分が変わりうる → 再検証のためツリーを更新
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => treeProvider.refresh()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ponpokoReview.refresh', () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('ponpokoReview.openDiff', (node: DiffNode) => {
      if (node.kind !== 'file') {
        return;
      }
      return openDiff(treeProvider.getBase(node.worktree.path), node);
    }),

    vscode.commands.registerCommand(
      'ponpokoReview.addComment',
      (reply: vscode.CommentReply) => {
        store.addComment(reply);
      },
    ),

    vscode.commands.registerCommand('ponpokoReview.submit', async () => {
      const worktrees = await worktreeList(repoRoot);
      await runSubmit(store.getThreads(), worktrees, '');
    }),

    vscode.commands.registerCommand('ponpokoReview.clear', () => {
      store.clear();
      vscode.window.showInformationMessage('ponpoko-review: コメントを消去しました。');
    }),

    // worktree 単位: そのworktreeのコメントだけ書き出す。
    vscode.commands.registerCommand(
      'ponpokoReview.submitWorktree',
      async (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const wt = node.worktree;
        await runSubmit(
          store.getThreadsUnder(wt.path),
          [wt],
          `${worktreeName(wt)} に `,
        );
      },
    ),

    // worktree 単位: そのworktreeのコメントだけクリア。
    vscode.commands.registerCommand(
      'ponpokoReview.clearWorktree',
      (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const n = store.clearUnder(node.worktree.path);
        vscode.window.showInformationMessage(
          `ponpoko-review: ${worktreeName(node.worktree)} のコメントを ${n} 件クリアしました。`,
        );
      },
    ),

    // worktree 単位: 比較先(base/target)ブランチを個別設定/解除。
    vscode.commands.registerCommand(
      'ponpokoReview.setWorktreeBase',
      async (node: WorktreeNode) => {
        if (!node || node.kind !== 'worktree') {
          return;
        }
        const wt = node.worktree;
        let branches: string[] = [];
        try {
          branches = await listBranches(wt.path);
        } catch {
          // 取得失敗時はそのまま（候補なし）。
        }
        const GLOBAL = '$(globe) グローバル設定に従う（上書き解除）';
        const current = treeProvider.getBase(wt.path);
        const picked = await vscode.window.showQuickPick([GLOBAL, ...branches], {
          placeHolder: `${worktreeName(wt)} の比較先(target)を選択（現在: ${current}）`,
        });
        if (picked === undefined) {
          return;
        }
        if (picked === GLOBAL) {
          await baseStore.clear(wt.path);
        } else {
          await baseStore.set(wt.path, picked);
        }
        treeProvider.refresh();
      },
    ),

    vscode.commands.registerCommand('ponpokoReview.setBase', async () => {
      let branches: string[] = [];
      try {
        branches = await listBranches(repoRoot);
      } catch {
        // 取得失敗時は入力に委ねる。
      }
      const current = treeProvider.getBase();
      const picked = await vscode.window.showQuickPick(branches, {
        placeHolder: `比較基準ブランチを選択（現在: ${current}）`,
      });
      if (!picked) {
        return;
      }
      await vscode.workspace
        .getConfiguration('ponpokoReview')
        .update('baseBranch', picked, vscode.ConfigurationTarget.Workspace);
      treeProvider.refresh();
    }),
  );
}

export function deactivate(): void {
  // subscriptions で破棄されるため特になし。
}
