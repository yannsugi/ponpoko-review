import * as vscode from 'vscode';
import { listBranches, viewHash, worktreeList } from './git';
import { DiffNode, DiffTreeProvider } from './diffTree';
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
      const threads = store.getThreads();
      if (threads.length === 0) {
        vscode.window.showWarningMessage('ponpoko-review: コメントがありません。');
        return;
      }
      try {
        const worktrees = await worktreeList(repoRoot);
        const result = await writeReview({
          repoRoot,
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
    }),

    vscode.commands.registerCommand('ponpokoReview.clear', () => {
      store.clear();
      vscode.window.showInformationMessage('ponpoko-review: コメントを消去しました。');
    }),

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
