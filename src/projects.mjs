import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { directoryPath, folderName } from './folders.mjs';

// Each conversation's exact working folder is its project. Browsing a folder alone does
// not create one; choosing it for a conversation does. Subfolders are separate projects.
// Project memories and requirements live in the database; the folder holds a small marker
// file so the project is still recognized after the folder is renamed or moved.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const windows = process.platform === 'win32';

export const pathKey = path => { const full = resolve(path).replace(/[\\/]+$/, '') || resolve(path); return windows ? full.toLowerCase() : full; };
export const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
// True when path is the folder itself or lies inside it.
export const within = (path, folder) => { const p = pathKey(path), f = pathKey(folder); return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep); };
const nameOf = folder => basename(resolve(folder)) || resolve(folder);

export const markerFile = folder => join(folder, '.starport', 'project.json');
// Everything Starport writes into a folder goes under .starport/, which ignores itself in git.
export function starportDir(folder) {
  const dir = join(folder, '.starport');
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Starport files (project marker, history archives, workflow ledgers)\n*\n');
  return dir;
}
export function readMarker(folder) {
  try { const data = JSON.parse(readFileSync(markerFile(folder), 'utf8')); return data?.starport === 'project' && uuid.test(data.id) ? data.id : null; }
  catch { return null; }
}
function writeMarker(folder, id) {
  starportDir(folder);
  writeFileSync(markerFile(folder), JSON.stringify({ starport: 'project', version: 1, id,
    note: '星港项目标识：工作文件夹就是项目；星港靠这个文件在文件夹改名或移动后认出原项目。' }, null, 2) + '\n');
}
// Removes the marker, and the .starport folder too when nothing else of Starport's is left in it.
function removeMarker(folder, id) {
  try {
    if (readMarker(folder) !== id) return;
    rmSync(markerFile(folder), { force: true });
    const dir = join(folder, '.starport');
    if (readdirSync(dir).every(name => name === '.gitignore')) rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export class ProjectFolders {
  constructor(store, { protectedPaths = () => [] } = {}) {
    this.store = store; this.db = store.db;
    store.projectFolders = this;
    this.protectedPaths = typeof protectedPaths === 'function' ? protectedPaths : () => protectedPaths;
  }
  // The project at the folder itself, if any.
  atRoot(folder) { return this.store.projects().find(p => p.workspace && samePath(p.workspace, folder)) || null; }
  // The project at this exact folder. A marker naming a known project whose recorded
  // folder is gone means the folder was renamed or moved outside Starport: follow it. If the
  // recorded folder still carries the same marker, this is a copy and needs its own identity.
  resolve(workspace) {
    if (typeof workspace !== 'string' || !workspace || !isAbsolute(workspace)) return null;
    const known = this.atRoot(workspace);
    if (known) return known;
    const id = readMarker(workspace), project = id ? this.store.project(id) : null;
    return project && this.follow(project, workspace) ? this.store.project(id) : null;
  }
  follow(project, dir) {
    if (project.workspace && existsSync(project.workspace) && readMarker(project.workspace) === project.id) return false;
    this.db.prepare('UPDATE projects SET workspace=?,name=? WHERE id=?').run(resolve(dir), nameOf(dir), project.id);
    return true;
  }
  ensure(workspace) {
    if (typeof workspace !== 'string' || !workspace || !isAbsolute(workspace)) return null;
    const folder = resolve(workspace);
    let project = this.resolve(folder);
    if (!project) project = this.store.addProject(nameOf(folder), folder);
    // Missing folders from old backups stay identifiable without recreating user folders.
    if (readMarker(folder) !== project.id && existsSync(folder) && statSync(folder).isDirectory()) this.writeMarker(folder, project.id);
    return project;
  }
  // Brings every conversation's project in line with its folder. Returns the ids that changed.
  sync(ids = null) {
    const rows = ids ? ids.map(id => this.db.prepare('SELECT id,workspace,project_id,options FROM chats WHERE id=?').get(id)).filter(Boolean)
      : this.db.prepare('SELECT id,workspace,project_id,options FROM chats').all();
    const found = new Map(), changed = [];
    for (const chat of rows) {
      // Internal desks inherit their caller's policy; exam seats must not create ordinary
      // projects or accidentally join another conversation's history-search boundary.
      if (JSON.parse(chat.options || '{}').desk) continue;
      if (!found.has(chat.workspace)) found.set(chat.workspace, this.ensure(chat.workspace)?.id || null);
      const id = found.get(chat.workspace);
      if ((chat.project_id || null) !== id) { this.db.prepare('UPDATE chats SET project_id=? WHERE id=?').run(id, chat.id); changed.push(chat.id); }
    }
    // Refresh only inherited scope on hidden desks; their own files/session stay untouched.
    for (const chat of this.db.prepare("SELECT id,project_id,options FROM chats WHERE json_extract(options,'$.desk') IS NOT NULL").all()) {
      const desk = JSON.parse(chat.options).desk;
      const id = desk.exam ? null : this.db.prepare('SELECT project_id FROM chats WHERE id=?').get(desk.parentChatId)?.project_id || null;
      if ((chat.project_id || null) !== id) this.db.prepare('UPDATE chats SET project_id=? WHERE id=?').run(id,chat.id);
    }
    return changed;
  }
  list() {
    const chats = new Map(this.db.prepare("SELECT project_id,COUNT(*) AS n FROM chats WHERE project_id IS NOT NULL AND json_extract(options,'$.desk') IS NULL GROUP BY project_id").all().map(r => [r.project_id, r.n]));
    const memories = new Map(this.db.prepare('SELECT project_id,COUNT(*) AS n FROM shared_memories WHERE project_id IS NOT NULL GROUP BY project_id').all().map(r => [r.project_id, r.n]));
    return this.store.projects().map(p => ({ ...p, chats: chats.get(p.id) || 0, memories: memories.get(p.id) || 0, missing: !!p.workspace && !existsSync(p.workspace) }));
  }
  // What the folder picker shows: the current folder's project, and which subfolders are projects.
  describe(listing) {
    const project = this.resolve(listing.path);
    const roots = new Set(this.store.projects().filter(p => p.workspace).map(p => pathKey(p.workspace)));
    const isProject = path => roots.has(pathKey(path)) || (() => { const id = readMarker(path); return !!id && !!this.store.project(id); })();
    // Starport's own .starport folder is not offered as a place to work.
    const folders = listing.folders.filter(folder => folder.name.toLowerCase() !== '.starport');
    return { ...listing, folders: folders.map(folder => isProject(folder.path) ? { ...folder, project: true } : folder),
      project: project ? { id: project.id, name: project.name, workspace: project.workspace, root: samePath(project.workspace, listing.path) } : null };
  }
  async mark(value) {
    const folder = await directoryPath(value);
    const existing = this.resolve(folder), project = this.ensure(folder);
    const warning = this.writeMarker(folder, project.id);
    this.sync();
    return { project: this.store.project(project.id), created: !existing, warning };
  }
  writeMarker(folder, id) {
    try { writeMarker(folder, id); return ''; }
    catch { return '项目已保存，但无法写入文件夹标识。在星港以外移动文件夹后，需要重新关联。'; }
  }
  // Keep old clients from silently detaching a folder under the new automatic model.
  unmark(id) {
    if (!this.store.project(id)) throw fail('项目不存在', 404);
    throw fail('工作文件夹就是项目，无需标记或取消标记。请更换对话的工作文件夹。', 409);
  }
  // Gives a project (for example one kept without a folder, or one synced from another
  // device) a folder on this machine.
  async attach(id, value) {
    const project = this.store.project(id);
    if (!project) throw fail('项目不存在', 404);
    const folder = await directoryPath(value), other = this.atRoot(folder);
    if (other && other.id !== id) throw fail(`这个文件夹已经是项目「${other.name}」`, 409);
    if (project.workspace && !samePath(project.workspace, folder)) removeMarker(project.workspace, id);
    this.db.prepare('UPDATE projects SET workspace=?,name=? WHERE id=?').run(folder, nameOf(folder), id);
    const warning = this.writeMarker(folder, id);
    this.sync();
    return { project: this.store.project(id), warning };
  }
  // Renames a folder on disk and every reference Starport holds to it or to folders inside it:
  // conversations' working folders and project folders. Fails cleanly while a conversation
  // inside is running or another program holds the folder open.
  async renameFolder(value, name, { isBusy = () => false } = {}) {
    const from = await directoryPath(value), clean = folderName(name);
    if (dirname(from) === from) throw fail('不能给磁盘根目录改名');
    const to = join(dirname(from), clean);
    if (to === from) return { path: from, chats: 0, projects: 0 };
    if (!samePath(to, from) && existsSync(to)) throw fail('同一位置已有同名的文件夹或文件', 409);
    if (this.protectedPaths().some(path => path && within(path, from))) throw fail('这个文件夹里有星港自己的程序、数据或记忆同步文件夹，不能在星港里改名', 409);
    const chats = this.db.prepare("SELECT id,title,workspace,json_extract(options,'$.desk.parentChatId') AS parent FROM chats").all().filter(c => c.workspace && isAbsolute(c.workspace) && within(c.workspace, from));
    const busy = chats.filter(c => isBusy(c.id) || (c.parent && isBusy(c.parent)));
    if (busy.length) {
      const titles = [...new Set(busy.map(c => c.parent ? this.store.chat(c.parent)?.title || c.title : c.title))];
      throw fail(`这些对话正在运行，等它们结束后再改名：${titles.slice(0, 5).join('、')}${titles.length > 5 ? ' 等' : ''}`, 409);
    }
    const projects = this.store.projects().filter(p => p.workspace && within(p.workspace, from));
    const archives = this.db.prepare('SELECT chat_id,workspace FROM history_archive_locations').all().filter(row => within(row.workspace, from));
    try { await rename(from, to); }
    catch (error) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw fail('文件夹或里面的文件正被其他程序占用（比如资源管理器窗口、编辑器、终端，或在别处运行的模型），关掉后再试', 409);
      throw fail('改名失败：' + error.message, 409);
    }
    const moved = path => to + resolve(path).slice(from.length);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const chat of chats) this.db.prepare('UPDATE chats SET workspace=? WHERE id=?').run(moved(chat.workspace), chat.id);
        for (const project of projects) { const path = moved(project.workspace); this.db.prepare('UPDATE projects SET workspace=?,name=? WHERE id=?').run(path, nameOf(path), project.id); }
        for (const archive of archives) this.db.prepare('UPDATE OR REPLACE history_archive_locations SET workspace=? WHERE chat_id=? AND workspace=?').run(moved(archive.workspace), archive.chat_id, archive.workspace);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      await rename(to, from).catch(() => {});
      throw fail('改名后没能更新星港里的路径，已把文件夹名改回：' + error.message, 500);
    }
    this.sync();
    return { path: to, chats: chats.filter(c => !c.parent).length, projects: projects.length };
  }
}
