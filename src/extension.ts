import * as vscode from 'vscode';
import * as path from 'path';
import { listBranches, viewHash, worktreeList, Worktree } from './git';
import { DiffNode, DiffTreeProvider, WorktreeNode, worktreeName } from './diffTree';
import { BASE_SCHEME, BaseContentProvider } from './baseContentProvider';
import { openDiff } from './openDiff';
import { CommentStore } from './comments';
import { writeReview } from './markdown';
import { ViewedStore } from './viewed';

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
        base: treeProvider.getBase(),
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

  // 差分ツリー
  const treeProvider = new DiffTreeProvider(repoRoot, viewed);
  const treeView = vscode.window.createTreeView('ponpokoReview.diffTree', {
    treeDataProvider: treeProvider,
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

  // チェックボックス操作 → viewed の保存/解除
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(async (e) => {
      const base = treeProvider.getBase();
      for (const [node, state] of e.items) {
        if (node.kind !== 'file') {
          continue;
        }
        if (state === vscode.TreeItemCheckboxState.Checked) {
          try {
            const hash = await viewHash(base, node.entry.path, node.worktree.path);
            await viewed.setViewed(node.worktree.path, node.entry.path, hash);
          } catch {
            // ハッシュ取得失敗時はマークしない。
          }
        } else {
          await viewed.unsetViewed(node.worktree.path, node.entry.path);
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
      return openDiff(treeProvider.getBase(), node);
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
