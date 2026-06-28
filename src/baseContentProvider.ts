import * as vscode from 'vscode';
import { showFileAtBase } from './git';

export const BASE_SCHEME = 'ponpoko-review-base';

/**
 * `ponpoko-review-base:` スキームの仮想ドキュメントに base 側の内容を供給する。
 *
 * URI の組み立ては {@link makeBaseUri} を使う:
 *   scheme: ponpoko-review-base
 *   path:   /<entry.path>            ← 拡張子から言語判定させるため実パスを載せる
 *   query:  base=<base>&cwd=<worktreePath>
 *
 * 追加ファイル等で base 側に存在しない場合は git show が失敗するので、空文字を返す。
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const base = params.get('base') ?? 'main';
    const cwd = params.get('cwd') ?? '';
    // path 先頭の '/' を除いた残りが対象ファイルパス。
    const filePath = uri.path.replace(/^\//, '');

    if (!cwd || !filePath) {
      return '';
    }

    try {
      return await showFileAtBase(base, filePath, cwd);
    } catch {
      // 追加ファイル（base 側に存在しない）→ 空ドキュメント。
      return '';
    }
  }
}

/** base 側仮想ドキュメントの URI を組み立てる。 */
export function makeBaseUri(base: string, cwd: string, filePath: string): vscode.Uri {
  const query = new URLSearchParams({ base, cwd }).toString();
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: '/' + filePath,
    query,
  });
}
