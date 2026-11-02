// Thin wrapper around `vscode.workspace.getConfiguration('pali')` so the
// install library can read and write settings without depending on the
// extension host directly. Both helpers are async so call sites stay uniform
// even if the underlying API ever becomes asynchronous.

import * as vscode from 'vscode';

const SECTION = 'pali';

/** Read one setting from the `pali` section. */
export async function get<T>(key: string): Promise<T> {
  return vscode.workspace.getConfiguration(SECTION).get<T>(key) as T;
}

/** Write one setting in the `pali` section. */
export async function update(
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget,
): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}
