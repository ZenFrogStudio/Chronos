import * as vscode from 'vscode';
import { parseUriList } from './library';
import { log } from './log';
import { Manager, toFsPath } from './manager';

/**
 * The activity-bar view. It exists because an activity-bar icon must open a
 * view container, and it stays deliberately thin: two rows that launch the
 * manager, not a second renderer duplicating it.
 *
 * It is a tree rather than `viewsWelcome` content because welcome content
 * cannot accept a drop, and this view's real job is being a drop target — the
 * manager's own webview cannot be one. VS Code disables mouse interaction over
 * a webview mid-drag (microsoft/vscode#182449), so a drag from the explorer
 * never reaches it unless you hold Shift, and a sandboxed webview can no longer
 * learn a dropped file's path either. A tree's drop handler runs extension-side
 * and receives real `Uri`s from both the explorer and the OS shell.
 */

interface LauncherItem {
  label: string;
  icon: string;
  command: string;
}

const ROWS: LauncherItem[] = [
  { label: 'Open Manager', icon: 'multiple-windows', command: 'chronus.openManager' },
  { label: 'Schedule a Markdown file...', icon: 'add', command: 'chronus.addFiles' }
];

export class LauncherView implements vscode.TreeDataProvider<LauncherItem> {
  getTreeItem(item: LauncherItem): vscode.TreeItem {
    const node = new vscode.TreeItem(item.label);
    node.iconPath = new vscode.ThemeIcon(item.icon);
    node.command = { command: item.command, title: item.label };
    return node;
  }

  getChildren(): LauncherItem[] {
    return ROWS;
  }
}

/** Schedules `.md` files dropped onto the launcher view, in place. */
export class PlanDropController implements vscode.TreeDragAndDropController<LauncherItem> {
  // 'files' covers the OS shell, 'text/uri-list' the VS Code explorer.
  readonly dropMimeTypes = ['text/uri-list', 'files'];
  readonly dragMimeTypes: string[] = [];

  constructor(private readonly manager: Manager) {}

  async handleDrop(
    _target: LauncherItem | undefined,
    data: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const paths = await this.readPaths(data);
    if (token.isCancellationRequested || !paths.length) {
      return;
    }
    // Open first, so the manager's inline notice about rejected files lands
    // somewhere the user can see it.
    this.manager.open();
    await this.manager.addPaths(paths);
  }

  private async readPaths(data: vscode.DataTransfer): Promise<string[]> {
    const list = await data.get('text/uri-list')?.asString();
    if (list) {
      return parseUriList(list).map(toFsPath);
    }

    // OS shell drops arrive as transfer items instead; `DataTransferFile.uri`
    // is populated on desktop, which is the only place Chronus runs a shell.
    const paths: string[] = [];
    data.forEach((item) => {
      const uri = item.asFile()?.uri;
      if (uri) {
        paths.push(uri.fsPath);
      }
    });

    if (!paths.length) {
      log.warn('a drop on the launcher carried no file paths');
    }
    return paths;
  }
}
