import * as path from 'path';
import { isInside, titleOf, toPlanFileName } from './library';

/**
 * Where a run's transcript lands. Pure path arithmetic — no `vscode`, no `fs` —
 * so the naming and the containment check are directly testable.
 *
 * The layout is a folder per plan and a file per run, named by local start
 * time and finished status:
 *
 *   results/nightly-audit/2026-07-26-2130-completed.md
 *   results/nightly-audit/2026-07-27-2130-failed.md
 *
 * That shape is chosen for reading outside VS Code. Scheduled work is reviewed
 * the next morning, often from a file manager, so the folder itself has to
 * answer "which nights went wrong" before anything is opened.
 */

/** Sortable, and unique enough — two runs of one plan in the same second is not a case. */
export function transcriptFileName(startedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    `-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}.md`
  );
}

/**
 * A plan's folder. Routed through the library's own slug rules rather than a
 * second implementation: those already strip path separators and traversal
 * segments, and they are already tested.
 */
export function planFolderName(fileName: string): string {
  return titleOf(toPlanFileName(titleOf(fileName) || fileName));
}

/**
 * The absolute path for one run's transcript.
 *
 * `fileName` originates from a path the user chose, so the result is checked
 * back against the root even though the slug rules above should already make
 * escape impossible. A transcript written outside the results folder would be
 * silently scattering files across the disk.
 */
export function resultPathFor(root: string, fileName: string, startedAt: Date): string {
  const candidate = path.join(root, planFolderName(fileName), transcriptFileName(startedAt));
  if (!isInside(root, candidate)) {
    throw new Error(`Refusing to write a transcript outside the results folder: ${fileName}`);
  }
  return candidate;
}

/** `…/2026-07-26-213045.md` -> `…/2026-07-26-213045-completed.md`. */
export function withStatus(filePath: string, status: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  return path.join(dir, `${path.basename(filePath, ext)}-${status}${ext}`);
}
