import * as vscode from 'vscode';

/** ファイルアイコン用 uri のスキーム（git標準装飾を避けつつ自前装飾を付ける）。 */
export const ICON_SCHEME = 'ponpoko-file';

const STATUS_COLOR: Record<string, string> = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  U: 'gitDecoration.conflictingResourceForeground',
};

/**
 * 行の右端に A/M/D/R のステータスバッジ（色付き）を出す FileDecorationProvider。
 * description ではなく装飾なので右寄せで表示される。ICON_SCHEME の uri だけ対象。
 */
export class StatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** fsPath -> status(A/M/D/R…) */
  private statuses = new Map<string, string>();

  setStatuses(map: Map<string, string>): void {
    this.statuses = map;
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ICON_SCHEME) {
      return undefined;
    }
    const status = this.statuses.get(uri.fsPath);
    if (!status) {
      return undefined;
    }
    return {
      badge: status,
      color: new vscode.ThemeColor(STATUS_COLOR[status] ?? STATUS_COLOR.M),
      tooltip: `status: ${status}`,
    };
  }
}
