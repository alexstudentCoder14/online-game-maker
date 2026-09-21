import { useCallback, useEffect, useRef, useState } from 'react'
import { ASSET_BUCKET, MAX_UPLOAD_BYTES, supabase } from '../lib/supabase'
import type { Project } from '../lib/types'
import { Engine } from '../engine/Engine'
import type { AssetResolver, BodyType, EntityData, LogLevel, SceneData, TransformMode, Vec3 } from '../engine/Engine'

interface Props {
  project: Project
  userId: string
  onBack: () => void
}

interface AssetRow {
  id: string
  name: string
  size_bytes: number | null
  metadata: { triangles?: number } | null
}

type SaveState = 'loading' | 'saved' | 'saving' | 'unsaved' | 'error'

const STARTER_SCRIPT = `// Runs once when you press Play.
function start() {
  log('Hello from ' + self.name)
}

// Runs every frame. dt is the time since the last frame, in seconds.
// Available: self (position, rotation, scale, setVelocity, addImpulse, teleport),
// input.key('KeyW'), find('Name'), log(...), THREE.
function update(dt) {
  self.rotation.y += dt
}
`

const round = (n: number) => Math.round(n * 1000) / 1000

const resolveAsset: AssetResolver = async (assetId) => {
  const { data: asset } = await supabase
    .from('assets')
    .select('storage_bucket, storage_path')
    .eq('id', assetId)
    .single()
  if (!asset) return null
  const { data } = await supabase.storage.from(asset.storage_bucket as string).createSignedUrl(asset.storage_path as string, 3600)
  return data?.signedUrl ?? null
}

export function Editor({ project, userId, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const sceneIdRef = useRef<string | null>(null)
  const readyRef = useRef(false)
  const timerRef = useRef<number | undefined>(undefined)

  const [entities, setEntities] = useState<EntityData[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<TransformMode>('translate')
  const [save, setSave] = useState<SaveState>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [stats, setStats] = useState({ drawCalls: 0, triangles: 0 })
  const [assets, setAssets] = useState<AssetRow[]>([])
  const [playing, setPlaying] = useState(false)
  const [starting, setStarting] = useState(false)
  const [logs, setLogs] = useState<{ level: LogLevel; text: string }[]>([])

  const loadAssets = useCallback(async () => {
    const { data } = await supabase
      .from('assets')
      .select('id, name, size_bytes, metadata')
      .eq('project_id', project.id)
      .order('created_at', { ascending: false })
    setAssets((data ?? []) as AssetRow[])
  }, [project.id])

  useEffect(() => {
    loadAssets()
  }, [loadAssets])

  async function addFromLibrary(asset: AssetRow) {
    const engine = engineRef.current
    if (!engine) return
    try {
      await engine.addModel(asset.id, asset.name.replace(/\.glb$/i, ''), () => resolveAsset(asset.id))
    } catch {
      setMessage(`Could not load ${asset.name}. The file may have been removed from storage.`)
    }
  }

  const saveNow = useCallback(async () => {
    const engine = engineRef.current
    const sceneId = sceneIdRef.current
    if (!engine || !sceneId || engine.playing) return
    setSave('saving')
    const { error } = await supabase.from('scenes').update({ data: engine.serialize() }).eq('id', sceneId)
    if (error) {
      setSave('error')
      setMessage(`Could not save: ${error.message}`)
      return
    }
    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', project.id)
    setSave('saved')
  }, [project.id])

  const scheduleSave = useCallback(() => {
    setSave('unsaved')
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(saveNow, 1500)
  }, [saveNow])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let engine: Engine
    try {
      engine = new Engine(host)
    } catch {
      setMessage('WebGL2 is not available in this browser. Try a current version of Chrome, Edge, Firefox or Safari.')
      setSave('error')
      return
    }
    engineRef.current = engine
    engine.onLog = (level, text) => setLogs((current) => [...current.slice(-199), { level, text }])

    const unsubscribe = engine.subscribe(() => {
      setEntities(engine.serialize().entities)
      setSelectedId(engine.selectedId)
      setMode(engine.mode)
      setPlaying(engine.playing)
      if (readyRef.current && !engine.playing) scheduleSave()
    })
    const statsTimer = window.setInterval(() => setStats(engine.getStats()), 500)

    ;(async () => {
      const { data, error } = await supabase
        .from('scenes')
        .select('id, data')
        .eq('project_id', project.id)
        .order('sort_order')
        .limit(1)
      if (cancelled) return
      if (error) {
        setSave('error')
        setMessage(`Could not load the scene: ${error.message}`)
        return
      }
      let row = data?.[0]
      if (!row) {
        const created = await supabase
          .from('scenes')
          .insert({ project_id: project.id, name: 'Main scene', data: {} })
          .select('id, data')
          .single()
        if (cancelled) return
        if (created.error || !created.data) {
          setSave('error')
          setMessage(`Could not create the scene: ${created.error?.message ?? 'unknown error'}`)
          return
        }
        row = created.data
      }
      sceneIdRef.current = row.id as string
      const scene = row.data as Partial<SceneData>
      try {
        if (scene.entities && scene.entities.length > 0) {
          await engine.loadScene(scene as SceneData, resolveAsset)
        } else {
          engine.addPrimitive('box')
        }
      } catch (err) {
        if (cancelled) return
        setSave('error')
        setMessage(`Could not open the scene: ${err instanceof Error ? err.message : 'unknown error'}`)
        return
      }
      if (cancelled) return
      readyRef.current = true
      setSave('saved')
    })()

    return () => {
      cancelled = true
      readyRef.current = false
      window.clearTimeout(timerRef.current)
      window.clearInterval(statsTimer)
      unsubscribe()
      engine.dispose()
      engineRef.current = null
    }
  }, [project.id, scheduleSave])

  async function importModel(file: File) {
    const engine = engineRef.current
    if (!engine) return
    if (!file.name.toLowerCase().endsWith('.glb')) {
      setMessage('Only .glb files can be imported for now. Export your model as GLB from Blender or your 3D tool, then try again.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setMessage('That file is larger than 50 MB. Compress it (Draco or Meshopt) and try again.')
      return
    }
    setMessage(`Importing ${file.name}…`)
    const assetId = crypto.randomUUID()
    const localUrl = URL.createObjectURL(file)
    try {
      const { id, triangles } = await engine.addModel(assetId, file.name.replace(/\.glb$/i, ''), async () => localUrl)
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
      const path = `${userId}/${project.id}/${assetId}-${safeName}`
      const upload = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { contentType: 'model/gltf-binary' })
      if (upload.error) {
        engine.removeEntity(id)
        engine.forgetAsset(assetId)
        setMessage(`Upload failed: ${upload.error.message}`)
        return
      }
      const { error } = await supabase.from('assets').insert({
        id: assetId,
        project_id: project.id,
        owner_id: userId,
        name: file.name,
        kind: 'model',
        storage_bucket: ASSET_BUCKET,
        storage_path: path,
        mime_type: 'model/gltf-binary',
        size_bytes: file.size,
        metadata: { triangles },
      })
      if (error) {
        await supabase.storage.from(ASSET_BUCKET).remove([path])
        engine.removeEntity(id)
        engine.forgetAsset(assetId)
        setMessage(`Could not save the asset: ${error.message}`)
        return
      }
      setMessage(null)
      loadAssets()
    } catch {
      setMessage('That file could not be read as a GLB model.')
    } finally {
      URL.revokeObjectURL(localUrl)
    }
  }

  const selected = entities.find((e) => e.id === selectedId) ?? null
  const engine = () => engineRef.current
  const saveLabel: Record<SaveState, string> = {
    loading: 'Loading…',
    saved: 'All changes saved',
    saving: 'Saving…',
    unsaved: 'Unsaved changes',
    error: 'Not saved',
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button
          onClick={async () => {
            engineRef.current?.stopPlay()
            window.clearTimeout(timerRef.current)
            if (readyRef.current && save !== 'saved') await saveNow()
            onBack()
          }}
        >
          Projects
        </button>
        <strong className="editor-title">{project.name}</strong>
        <span className={`save-state ${save}`} role="status">{saveLabel[save]}</span>
        <div className="spacer" />
        <button
          className={playing ? 'danger' : 'primary'}
          disabled={save === 'loading' || starting}
          onClick={async () => {
            const en = engine()
            if (!en) return
            if (en.playing) return en.stopPlay()
            setLogs([])
            setStarting(true)
            try {
              await en.startPlay()
            } catch {
              setMessage('The game could not start. See the console for details.')
            } finally {
              setStarting(false)
            }
          }}
        >
          {playing ? 'Stop' : starting ? 'Starting…' : 'Play'}
        </button>
        <div className="segmented" role="group" aria-label="Transform tool">
          {(
            [
              ['translate', 'Move (W)'],
              ['rotate', 'Rotate (E)'],
              ['scale', 'Scale (R)'],
            ] as [TransformMode, string][]
          ).map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => engine()?.setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <aside className="panel left">
        <fieldset className="bare" disabled={playing}>
        <h2>Scene</h2>
        <div className="add-row">
          <button onClick={() => engine()?.addPrimitive('box')}>Add cube</button>
          <button onClick={() => engine()?.addPrimitive('sphere')}>Add sphere</button>
          <button onClick={() => fileRef.current?.click()}>Import model</button>
          <input
            ref={fileRef}
            type="file"
            accept=".glb,model/gltf-binary"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) importModel(file)
            }}
          />
        </div>
        {entities.length === 0 ? (
          <p className="empty">The scene is empty. Add a shape or import a GLB model.</p>
        ) : (
          <ul className="tree">
            {entities.map((e) => (
              <li key={e.id}>
                <button aria-current={e.id === selectedId} onClick={() => engine()?.select(e.id)}>
                  <span className="kind">{e.kind}</span>
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <h2 className="section-gap">Model library</h2>
        {assets.length === 0 ? (
          <p className="empty">Models you import are saved here, so you can add them to any scene again.</p>
        ) : (
          <ul className="tree">
            {assets.map((a) => (
              <li key={a.id}>
                <button onClick={() => addFromLibrary(a)} title="Add to scene">
                  <span className="kind">
                    {a.metadata?.triangles ? `${Math.round(a.metadata.triangles / 1000)}k` : 'glb'}
                  </span>
                  {a.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        </fieldset>
      </aside>

      <div className="viewport-wrap">
        <div className="viewport" ref={hostRef} />
        {(playing || logs.length > 0) && (
          <div className="console" role="log" aria-label="Game console">
            <div className="console-head">
              <strong>Console</strong>
              <button onClick={() => setLogs([])}>Clear</button>
            </div>
            {logs.length === 0 ? (
              <p className="muted">No messages yet. Use log(...) in a script.</p>
            ) : (
              logs.map((l, i) => (
                <div key={i} className={l.level === 'error' ? 'error' : ''}>
                  {l.text}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <aside className="panel right">
        <fieldset className="bare" disabled={playing}>
        <h2>Inspector</h2>
        {selected ? (
          <div key={selected.id} className="inspector">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                value={selected.name}
                onChange={(e) => engine()?.updateEntity(selected.id, { name: e.target.value })}
              />
            </label>
            <Vec3Field label="Position" value={selected.position} onChange={(v) => engine()?.updateEntity(selected.id, { position: v })} />
            <Vec3Field label="Rotation" value={selected.rotation} step={1} onChange={(v) => engine()?.updateEntity(selected.id, { rotation: v })} />
            <Vec3Field label="Scale" value={selected.scale} onChange={(v) => engine()?.updateEntity(selected.id, { scale: v })} />
            <label className="field">
              <span className="field-label">Physics body</span>
              <select
                value={selected.components?.rigidbody?.type ?? 'none'}
                onChange={(e) => {
                  const value = e.target.value
                  const next = { ...selected.components }
                  if (value === 'none') delete next.rigidbody
                  else next.rigidbody = { type: value as BodyType }
                  engine()?.updateEntity(selected.id, { components: next })
                }}
              >
                <option value="none">None</option>
                <option value="dynamic">Dynamic (falls and collides)</option>
                <option value="static">Static (solid, never moves)</option>
                <option value="kinematic">Kinematic (moved by scripts)</option>
              </select>
            </label>
            <div className="field">
              <span className="field-label">Script</span>
              {selected.components?.script ? (
                <>
                  <textarea
                    className="code"
                    spellCheck={false}
                    rows={12}
                    value={selected.components.script.code}
                    onChange={(e) =>
                      engine()?.updateEntity(selected.id, {
                        components: { ...selected.components, script: { code: e.target.value } },
                      })
                    }
                  />
                  <button
                    onClick={() => {
                      const next = { ...selected.components }
                      delete next.script
                      engine()?.updateEntity(selected.id, { components: next })
                    }}
                  >
                    Remove script
                  </button>
                </>
              ) : (
                <button
                  onClick={() =>
                    engine()?.updateEntity(selected.id, {
                      components: { ...selected.components, script: { code: STARTER_SCRIPT } },
                    })
                  }
                >
                  Add script
                </button>
              )}
            </div>
            <div className="add-row">
              <button onClick={() => engine()?.duplicateEntity(selected.id)}>Duplicate (Ctrl+D)</button>
              <button className="danger" onClick={() => engine()?.removeEntity(selected.id)}>
                Delete object
              </button>
            </div>
          </div>
        ) : (
          <p className="empty">Select an object in the scene or the viewport to edit it.</p>
        )}
        </fieldset>
      </aside>

      <footer className="status">
        {message ? (
          <span className={save === 'error' ? 'error' : ''} role="status">{message}</span>
        ) : (
          <>
            <span>{entities.length} objects</span>
            <span>{stats.drawCalls} draw calls</span>
            <span>{stats.triangles.toLocaleString()} triangles</span>
          </>
        )}
      </footer>
    </div>
  )
}

function Vec3Field({
  label,
  value,
  onChange,
  step = 0.1,
}: {
  label: string
  value: Vec3
  onChange: (v: Vec3) => void
  step?: number
}) {
  function commit(index: number, raw: string) {
    const parsed = parseFloat(raw)
    if (Number.isNaN(parsed) || parsed === round(value[index])) return
    const next = [...value] as Vec3
    next[index] = parsed
    onChange(next)
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="vec">
        {value.map((n, i) => (
          <input
            key={`${i}:${round(n)}`}
            type="number"
            step={step}
            defaultValue={round(n)}
            aria-label={`${label} ${'XYZ'[i]}`}
            onBlur={(e) => commit(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        ))}
      </div>
    </div>
  )
}
