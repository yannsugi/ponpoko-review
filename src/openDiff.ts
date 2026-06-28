import * as vscode from 'vscode';
import * as path from 'path';
import { FileNode } from './diffTree';
import { mergeBase } from './git';
import { BASE_SCHEME, makeBaseUri } from './baseContentProvider';

/** 空の base スキーム URI（cwd 空 → プロバイダが '' を返す）。追加/削除の片側用。 */
function makeEmptyUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: '/' + filePath,
    query: new URLSearchParams({ base: '', cwd: '' }).toString(),
  });
}

/**
 * ツリーの FileNode をクリックしたとき、左=base 側仮想doc / 右=作業ツリーの実ファイルで
 * vscode.diff を開く。追加/削除ファイルは片側を空にする。
 *
 * ★重要: 右(right)は必ず作業ツリーの実ファイル uri。コメントは右に付けるので
 *   行番号が HEAD 基準でそのまま使える。
 */
export async function openDiff(base: string, node: FileNode): Promise<void> {
  const { worktree, entry } = node;
  const cwd = worktree.path;
  // base 側で参照すべきパス（リネーム時は旧パス）。
  const basePath = entry.oldPath ?? entry.path;
  const workingUri = vscode.Uri.file(path.join(cwd, entry.path));
  const title = `${entry.path} (${base}...HEAD)`;

  // 左側は base の先端ではなく merge-base から供給する（base...HEAD の三点ドット相当）。
  // こうしないと base(main)がブランチ後に進んだとき、main側の変更が"あなたの削除"として出る。
  let leftRef = base;
  try {
    leftRef = await mergeBase(base, cwd);
  } catch {
    // merge-base が取れない場合は base 先端にフォールバック。
  }

  let leftUri: vscode.Uri;
  let rightUri: vscode.Uri;

  if (entry.status === 'A') {
    // 追加: 左を空に。
    leftUri = makeEmptyUri(entry.path);
    rightUri = workingUri;
  } else if (entry.status === 'D') {
    // 削除: 右を空に。
    leftUri = makeBaseUri(leftRef, cwd, basePath);
    rightUri = makeEmptyUri(entry.path);
  } else {
    leftUri = makeBaseUri(leftRef, cwd, basePath);
    rightUri = workingUri;
  }

  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}
