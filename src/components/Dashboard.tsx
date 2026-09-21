import { useCallback, useEffect, useState } from 'react'
import { ASSET_BUCKET, supabase } from '../lib/supabase'
import type { Project } from '../lib/types'

interface Props {
  userId: string
  email: string
  onOpen: (project: Project) => void
}

export function Dashboard({ userId, email, onOpen }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('updated_at', { ascending: false })
    if (error) setError(error.message)
    else setProjects(data as Project[])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: trimmed, owner_id: userId })
      .select('*')
      .single()
    setBusy(false)
    if (error) return setError(error.message)
    setName('')
    open(data as Project)
  }

  function open(project: Project) {
    supabase
      .from('projects')
      .update({ last_opened_at: new Date().toISOString() })
      .eq('id', project.id)
      .then(() => undefined)
    onOpen(project)
  }

  async function remove(project: Project) {
    if (!window.confirm(`Delete "${project.name}" and all of its scenes and assets? This cannot be undone.`)) return
    setError(null)
    // Storage objects are not removed by database cascades, so delete them first.
    const { data: assets } = await supabase.from('assets').select('storage_path').eq('project_id', project.id)
    const paths = (assets ?? []).map((a) => a.storage_path as string)
    if (paths.length) await supabase.storage.from(ASSET_BUCKET).remove(paths)
    const { error } = await supabase.from('projects').delete().eq('id', project.id)
    if (error) return setError(error.message)
    setProjects((current) => (current ?? []).filter((p) => p.id !== project.id))
  }

  return (
    <main className="dash">
      <header className="dash-head">
        <h1>Your projects</h1>
        <div className="dash-user">
          <span className="muted">{email}</span>
          <button onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>

      <form className="new-project" onSubmit={create}>
        <input
          placeholder="Name your new game"
          aria-label="New project name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()}>
          Create project
        </button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {projects === null ? (
        <p className="muted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="empty">You have no projects yet. Name your first game above to open the editor.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button className="project-open" onClick={() => open(p)}>
                <span className="project-name">{p.name}</span>
                <span className="muted">Edited {new Date(p.updated_at).toLocaleDateString()}</span>
              </button>
              <button className="danger" onClick={() => remove(p)} aria-label={`Delete ${p.name}`}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
