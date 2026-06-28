import * as vscode from 'vscode';

/**
 * GitHub PR の "Viewed" 相当。ファイルごとに「表示済み」フラグと、
 * チェックした時点の差分ハッシュを workspaceState に永続化する。
 * 値の有無 = viewed、値 = チェック時の差分ハッシュ。
 */
export class ViewedStore {
  constructor(private readonly state: vscode.Memento) {}

  private key(worktreePath: string, file: string): string {
    return `ponpoko.viewed:${worktreePath}::${file}`;
  }

  isViewed(worktreePath: string, file: string): boolean {
    return this.state.get<string>(this.key(worktreePath, file)) !== undefined;
  }

  /** チェック時に保存した差分ハッシュ。未 viewed なら undefined。 */
  getHash(worktreePath: string, file: string): string | undefined {
    return this.state.get<string>(this.key(worktreePath, file));
  }

  /** viewed にする（現在の差分ハッシュを記録）。 */
  async setViewed(worktreePath: string, file: string, hash: string): Promise<void> {
    await this.state.update(this.key(worktreePath, file), hash);
  }

  /** viewed を外す。 */
  async unsetViewed(worktreePath: string, file: string): Promise<void> {
    await this.state.update(this.key(worktreePath, file), undefined);
  }
}
