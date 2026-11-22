/**
 * Host half of the side-notes bundle.
 *
 * Registers `/side-notes-clear`: deletes the 档 3 旁问 session log groups
 * (`~/.dsh/sessions/*side-notes-ask*`) to free disk. The Client button in the
 * settings view triggers it via `session.command('/side-notes-clear')`.
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Required host services. */
export const inject = ['commands'];

/** DSH 会话存储根目录（Desktop 默认在 ~/.dsh/sessions）。 */
function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions');
}

/** 删除所有旁问（含 side-notes-ask）会话组目录，返回删除统计。 */
function clearSideNotesCache() {
  const root = sessionsRoot();
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: '读取会话目录失败：' + (err && err.message ? err.message : err) };
  }
  let groups = 0;
  let sessions = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes('side-notes-ask')) continue;
    const full = join(root, entry.name);
    let count = 0;
    try { count = readdirSync(full).length; } catch (err) { count = 0; }
    try {
      rmSync(full, { recursive: true, force: true });
      groups += 1;
      sessions += count;
    } catch (err) {
      console.error('[side-notes] 清理失败', full, err);
    }
  }
  return { ok: true, groups, sessions };
}

/** Register the cleanup command on the host command registry. */
export function apply(ctx) {
  ctx.commands.register({
    definitionId: 'dsh-side-notes/clear',
    name: 'side-notes-clear',
    description: '清理旁问（档 3）会话缓存，释放磁盘',
    handler: () => {
      const r = clearSideNotesCache();
      if (!r.ok) return { kind: 'error', text: r.error };
      if (!r.groups) return { kind: 'success', text: '没有需要清理的旁问缓存。' };
      return { kind: 'success', text: '已清理 ' + r.groups + ' 组、' + r.sessions + ' 个旁问会话。' };
    },
  });
}
