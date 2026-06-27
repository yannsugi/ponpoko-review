import * as vscode from 'vscode';

/**
 * worktree ごとの比較先(base/target)ブランチの上書きを workspaceState に永続化する。
 * 値が無ければグローバル設定 ponpokoReview.baseBranch にフォールバックする。
 */
export class WorktreeBaseStore {
  constructor(private readonly state: vscode.Memento) {}

  private key(worktreePath: string): string {
    return `ponpoko.base:${worktreePath}`;
  }

  /** この worktree の上書き base。無ければ undefined。 */
  get(worktreePath: string): string | undefined {
    return this.state.get<string>(this.key(worktreePath));
  }

  async set(worktreePath: string, base: string): Promise<void> {
    await this.state.update(this.key(worktreePath), base);
  }

  /** 上書きを解除（グローバル設定に従う）。 */
  async clear(worktreePath: string): Promise<void> {
    await this.state.update(this.key(worktreePath), undefined);
  }
}
