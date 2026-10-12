import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Category, Project } from '../../shared/contracts';
import { api, errorMessage } from '../api';
import styles from './Projects.module.css';

type EditProject = Pick<Project, 'name' | 'category_id' | 'color'>;
function ProjectForm({ project, categories, disabled, onSave }: {
  project?: Project; categories: Category[]; disabled: boolean;
  onSave: (value: EditProject) => Promise<boolean>;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [category, setCategory] = useState(project?.category_id ?? 'uncategorized');
  const [color, setColor] = useState(project?.color ?? '#175c50');
  useEffect(() => { if (project) { setName(project.name); setCategory(project.category_id); setColor(project.color); } }, [project]);
  useEffect(() => { if (!categories.some((c) => c.id === category)) setCategory('uncategorized'); }, [categories, category]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await onSave({ name: name.trim(), category_id: category, color }) && !project) setName('');
  }
  return <form onSubmit={submit}>
    <fieldset disabled={disabled} className={styles.fields}>
      <label>作業名<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>カテゴリ<select value={category} onChange={(e) => setCategory(e.target.value)}>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      <label>表示色<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
      <button type="submit" disabled={!name.trim()}>{project ? '変更を保存' : '作業を追加'}</button>
    </fieldset>
  </form>;
}
function CategoryEditor({ category, disabled, onRename, onDelete }: {
  category: Category; disabled: boolean; onRename: (name: string) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);
  return <li className={styles.category}>
    {category.id === 'uncategorized' ? <span>未分類（標準）</span> : <>
      <form onSubmit={(e) => { e.preventDefault(); onRename(name.trim()); }} className={styles.inline}>
        <label>カテゴリ名<input required maxLength={80} value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={disabled || !name.trim()}>改名</button>
      </form>
      <button type="button" disabled={disabled} onClick={onDelete}>削除</button>
    </>}
  </li>;
}
export default function Projects() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [newCategory, setNewCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api<{ categories: Category[] }>('/categories'), api<{ projects: Project[] }>('/projects?scope=all')]);
    setCategories(c.categories); setProjects(p.projects); setLoaded(true);
  }, []);
  useEffect(() => { load().catch((e) => setError(errorMessage(e))); }, [load]);
  async function mutate(path: string, method: string, value?: unknown) {
    if (busy) return false;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(path, { method, ...(value ? { body: JSON.stringify(value) } : {}) });
      await load(); setMessage('保存しました。'); return true;
    } catch (e) { setError(errorMessage(e)); return false; }
    finally { setBusy(false); }
  }
  return <section>
    <h1>作業管理</h1><p>作業を登録して、タイマーで選択できます。</p>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => { setError(''); load().catch((e) => setError(errorMessage(e))); }}>再読み込み</button></p>}
    {message && <p role="status">{message}</p>}
    {!loaded ? <p>読み込み中…</p> : <>
      <div className={styles.panel}>
        <h2>カテゴリ</h2>
        <form className={styles.inline} onSubmit={async (e) => {
          e.preventDefault(); if (await mutate('/categories', 'POST', { name: newCategory.trim() })) setNewCategory('');
        }}>
          <label>新しいカテゴリ<input required maxLength={80} disabled={busy} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} /></label>
          <button disabled={busy || !newCategory.trim()}>追加</button>
        </form>
        <ul className={styles.categories}>{categories.map((c) => <CategoryEditor key={c.id} category={c} disabled={busy}
          onRename={(name) => { void mutate(`/categories/${c.id}`, 'PATCH', { name }); }}
          onDelete={() => { if (window.confirm(`「${c.name}」を削除しますか？所属作業は未分類へ移り、実績は保持されます。`)) void mutate(`/categories/${c.id}`, 'DELETE'); }} />)}</ul>
      </div>
      <div className={styles.panel}><h2>新しい作業</h2><ProjectForm categories={categories} disabled={busy} onSave={(value) => mutate('/projects', 'POST', value)} /></div>
      <h2>登録済みの作業</h2>
      {!projects.length && <p>まだ作業がありません。</p>}
      {projects.map((p) => <article key={p.id} className={styles.panel} aria-label={p.name}>
        <h3><span className={styles.dot} style={{ backgroundColor: p.color }} />{p.name}{p.archived && '（アーカイブ済み）'}</h3>
        <ProjectForm project={p} categories={categories} disabled={busy} onSave={(value) => mutate(`/projects/${p.id}`, 'PATCH', value)} />
        <button disabled={busy} onClick={() => { void mutate(`/projects/${p.id}`, 'PATCH', { archived: !p.archived }); }}>{p.archived ? 'アーカイブを解除' : 'アーカイブする'}</button>
      </article>)}
    </>}
  </section>;
}
