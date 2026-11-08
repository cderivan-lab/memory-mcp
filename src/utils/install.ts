// Automatically install pali binary releases from GitHub.
// This wraps `@pali/install` in the VSCode UI. See that package for more.

import * as common from './install_pali';
import * as path from 'path';
import * as vscode from 'vscode';

import * as config from './config';

// Returns the pali path to be used, or null if pali is not installed.
export async function activate(disposables: vscode.Disposable[],
  globalStoragePath: string,
  extensionPath: string,
  getToken?: () => Promise<string | null>):
  Promise<common.PrepareResult> {
  const ui = await UI.create(disposables, globalStoragePath, extensionPath,
    getToken);
  disposables.push(vscode.commands.registerCommand(
    'pali.install', async () => common.installLatest(ui)));
  disposables.push(vscode.commands.registerCommand(
    'pali.update', async () => common.checkUpdates(true, ui)));
  return await common.prepare(ui, await config.get<boolean>('checkUpdates'));
}

export class UI {
  static async create(disposables: vscode.Disposable[],
    globalStoragePath: string,
    extensionRoot: string,
    tokenGetter?: () => Promise<string | null>): Promise<UI> {
    const ui = new UI(disposables, globalStoragePath, extensionRoot, tokenGetter);
    await ui.resolvePaliPath();
    return ui;
  }

  private constructor(private disposables: vscode.Disposable[],
    private globalStoragePath: string,
    private extensionRoot: string,
    private tokenGetter?: () => Promise<string | null>) { }

  get storagePath(): string { return this.globalStoragePath; }
  get extensionPath(): string { return this.extensionRoot; }
  /** HTTPS token for private-repo downloads, read fresh from secret storage. */
  async getToken(): Promise<string | null> {
    return (await this.tokenGetter?.()) ?? null;
  }
  async choose(prompt: string, options: string[]): Promise<string | undefined> {
    return await vscode.window.showInformationMessage(prompt, ...options);
  }
  slow<T>(title: string, result: Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: false,
    };
    return Promise.resolve(vscode.window.withProgress(opts, () => result));
  }
  progress<T>(title: string, cancel: AbortController | null,
    body: (progress: (fraction: number) => void) => Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: cancel !== null,
    };
    const result = vscode.window.withProgress(opts, async (progress, canc) => {
      if (cancel)
        canc.onCancellationRequested(() => cancel.abort());
      let lastFraction = 0;
      return body(fraction => {
        if (fraction > lastFraction) {
          progress.report({ increment: 100 * (fraction - lastFraction) });
          lastFraction = fraction;
        }
      });
    });
    return Promise.resolve(result); // Thenable to real promise.
  }
  localize(message: string, ...args: Array<string | number | boolean>): string {
    let ret = message;
    for (const i in args) {
      ret = ret.replace(`{${i}}`, args[i].toString());
    }
    return ret;
  }
  error(s: string) { vscode.window.showErrorMessage(s); }
  info(s: string) { vscode.window.showInformationMessage(s); }
  command(name: string, body: () => any) {
    this.disposables.push(vscode.commands.registerCommand(name, body));
  }

  async shouldReuse(release: string): Promise<boolean | undefined> {
    const message = `pali ${release} is already installed!`;
    const use = 'Use the installed version';
    const reinstall = 'Delete it and reinstall';
    const response =
      await vscode.window.showInformationMessage(message, use, reinstall);
    if (response === use) {
      // Find pali within the existing directory.
      return true;
    } else if (response === reinstall) {
      // Remove the existing installation.
      return false;
    } else {
      // User dismissed prompt, bail out.
      return undefined;
    }
  }

  private _pathUpdated: Promise<void> | null = null;

  async promptReload(message: string) {
    vscode.window.showInformationMessage(message);
    await this._pathUpdated;
    this._pathUpdated = null;
    vscode.commands.executeCommand('pali.restart');
  }

  async promptUpdate(oldVersion: string, newVersion: string) {
    const message = 'An updated pali language server is available.\n ' +
      `Would you like to upgrade to pali ${newVersion}? ` +
      `(from ${oldVersion})`;
    const update = `Install pali ${newVersion}`;
    const dontCheck = 'Don\'t ask again';
    const response =
      await vscode.window.showInformationMessage(message, update, dontCheck);
    if (response === update) {
      await common.installLatest(this);
    } else if (response === dontCheck) {
      await config.update('checkUpdates', false, vscode.ConfigurationTarget.Global);
    }
  }

  async resolvePaliPath() {
    let p = await config.get<string>('path');
    // Backwards compatibility: if it's a relative path with a slash, interpret
    // relative to project root.
    if (!path.isAbsolute(p) && p.includes(path.sep) &&
      vscode.workspace.rootPath !== undefined) {
      p = path.join(vscode.workspace.rootPath, p);
    }

    this._paliPath = p;
  }

  private _paliPath?: string = undefined;

  get paliPath(): string { return this._paliPath as string; }
  set paliPath(p: string) {
    this._paliPath = p;
    this._pathUpdated = new Promise(resolve => {
      config.update('path', p, vscode.ConfigurationTarget.Global).then(() => {
        resolve();
      }).catch(() => {
        // Ignore errors; path update failure is non-critical.
      });
    });
  }
}