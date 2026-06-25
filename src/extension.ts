import * as vscode from 'vscode';
import { listBranches, worktreeList } from './git';
import { DiffNode, DiffTreeProvider } from './diffTree';
import { BASE_SCHEME, BaseContentProvider } from './baseContentProvider';
import { openDiff } from './openDiff';
import { CommentStore } from './comments';
import { writeReview } from './markdown';

export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) {
    vscode.window.showWarningMessage('ぽんぽこレビュー: ワークスペースが開かれていません。');
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

  // 差分ツリー
  const treeProvider = new DiffTreeProvider(repoRoot);
  context.subscriptions.push(
    vscode.window.createTreeView('ponpokoReview.diffTree', {
      treeDataProvider: treeProvider,
    }),
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
        vscode.window.showWarningMessage('ぽんぽこレビュー: コメントがありません。');
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
          `ぽんぽこレビュー: ${result.itemCount} 件を ${result.files.length} ファイルに書き出しました。`,
          '開く',
        );
        if (choice === '開く' && result.files.length > 0) {
          const doc = await vscode.workspace.openTextDocument(result.files[0]);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `ぽんぽこレビュー: 書き出しに失敗: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('ponpokoReview.clear', () => {
      store.clear();
      vscode.window.showInformationMessage('ぽんぽこレビュー: コメントを消去しました。');
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
