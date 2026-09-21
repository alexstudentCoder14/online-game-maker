import { useState } from 'react'
import { useSession } from './lib/useSession'
import type { Project } from './lib/types'
import { AuthPage } from './components/AuthPage'
import { Dashboard } from './components/Dashboard'
import { Editor } from './components/Editor'

export default function App() {
  const { session, loading } = useSession()
  const [project, setProject] = useState<Project | null>(null)

  if (loading) return <div className="screen-center muted">Loading…</div>
  if (!session) return <AuthPage />

  if (project) {
    return (
      <Editor
        key={project.id}
        project={project}
        userId={session.user.id}
        onBack={() => setProject(null)}
      />
    )
  }

  return <Dashboard userId={session.user.id} email={session.user.email ?? ''} onOpen={setProject} />
}
