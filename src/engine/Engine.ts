import * as THREE from 'three'
import type { RigidBody, World } from '@dimforge/rapier3d-compat'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

export type Vec3 = [number, number, number]
export type EntityKind = 'box' | 'sphere' | 'model'
export type TransformMode = 'translate' | 'rotate' | 'scale'
export type BodyType = 'dynamic' | 'static' | 'kinematic'
export type LogLevel = 'log' | 'error'

/** Components attached to an entity. Stored inside the scene JSON. */
export interface Components {
  rigidbody?: { type: BodyType }
  script?: { code: string }
}

type RapierModule = typeof import('@dimforge/rapier3d-compat').default

export interface EntityData {
  id: string
  name: string
  kind: EntityKind
  assetId?: string
  position: Vec3
  rotation: Vec3 // degrees
  scale: Vec3
  components?: Components
}

export interface SceneData {
  version: 1
  entities: EntityData[]
}

export type AssetResolver = (assetId: string) => Promise<string | null>

interface Entity {
  id: string
  name: string
  kind: EntityKind
  assetId?: string
  components: Components
  object: THREE.Object3D
}

interface PlayBody {
  body: RigidBody
  type: BodyType
  object: THREE.Object3D
}

interface ScriptInstance {
  name: string
  start: (() => void) | null
  update: ((dt: number, time: number) => void) | null
  failed: boolean
}

interface PlayState {
  world: World
  bodies: Map<string, PlayBody>
  scripts: ScriptInstance[]
  initial: Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>
  last: number
  accumulator: number
  time: number
}

const DEG = Math.PI / 180

/**
 * Editor viewport engine (WebGL2 via Three.js).
 * Renders on demand: a frame is drawn only when something changed, which keeps
 * the GPU and CPU idle while the user is not interacting.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  selectedId: string | null = null
  mode: TransformMode = 'translate'
  playing = false
  /** Receives console.log-style output and script errors while playing. */
  onLog: (level: LogLevel, text: string) => void = () => {}

  private orbit: OrbitControls
  private transform: TransformControls
  private raycaster = new THREE.Raycaster()
  private entities = new Map<string, Entity>()
  /** One loaded copy per model asset. Scene objects are clones that share its geometry and materials. */
  private templates = new Map<string, THREE.Object3D>()
  private listeners = new Set<() => void>()
  private gltf: GLTFLoader
  private draco: DRACOLoader
  private dirty = true
  private raf = 0
  private silent = false
  private resizeObserver: ResizeObserver
  private downAt: { x: number; y: number } | null = null
  private host: HTMLElement
  private play: PlayState | null = null
  private starting = false
  private rapier: RapierModule | null = null
  private keys = new Set<string>()

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x161a23)
    host.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000)
    this.camera.position.set(4, 3, 6)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3040, 1.1))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(5, 8, 4)
    this.scene.add(sun)
    this.scene.add(new THREE.GridHelper(40, 40, 0x4a5470, 0x2a3142))

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.addEventListener('change', () => this.invalidate())

    this.transform = new TransformControls(this.camera, this.renderer.domElement)
    this.transform.addEventListener('change', () => this.invalidate())
    this.transform.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value
    })
    this.transform.addEventListener('objectChange', () => this.emit())
    this.scene.add(this.transform.getHelper())

    this.draco = new DRACOLoader()
    this.draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    this.gltf = new GLTFLoader()
    this.gltf.setDRACOLoader(this.draco)
    this.gltf.setMeshoptDecoder(MeshoptDecoder)

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(host)
    this.resize()
    this.loop()
  }

  // ---- lifecycle ----------------------------------------------------------

  dispose() {
    cancelAnimationFrame(this.raf)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.play?.world.free()
    this.play = null
    this.playing = false
    this.resizeObserver.disconnect()
    this.silent = true
    this.clear()
    for (const template of this.templates.values()) this.disposeObject(template)
    this.templates.clear()
    this.transform.dispose()
    this.orbit.dispose()
    this.draco.dispose()
    this.renderer.dispose()
    canvas.remove()
    this.listeners.clear()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getStats() {
    const info = this.renderer.info.render
    return { drawCalls: info.calls, triangles: info.triangles }
  }

  // ---- scene API ----------------------------------------------------------

  serialize(): SceneData {
    const entities: EntityData[] = []
    for (const e of this.entities.values()) {
      const o = e.object
      entities.push({
        id: e.id,
        name: e.name,
        kind: e.kind,
        assetId: e.assetId,
        components: e.components,
        position: [o.position.x, o.position.y, o.position.z],
        rotation: [o.rotation.x / DEG, o.rotation.y / DEG, o.rotation.z / DEG],
        scale: [o.scale.x, o.scale.y, o.scale.z],
      })
    }
    return { version: 1, entities }
  }

  addPrimitive(kind: 'box' | 'sphere'): string {
    const object = this.makePrimitive(kind)
    object.position.y = 0.5
    const count = [...this.entities.values()].filter((e) => e.kind === kind).length + 1
    const name = `${kind === 'box' ? 'Cube' : 'Sphere'} ${count}`
    const id = this.register({ id: crypto.randomUUID(), name, kind, object })
    this.select(id)
    return id
  }

  async addModel(
    assetId: string,
    name: string,
    url: () => Promise<string | null>,
  ): Promise<{ id: string; triangles: number }> {
    const template = await this.template(assetId, url)
    if (!template) throw new Error('Model file not found')
    const object = cloneSkinned(template)
    const triangles = this.countTriangles(template)
    const id = this.register({ id: crypto.randomUUID(), name, kind: 'model', assetId, object })
    this.select(id)
    return { id, triangles }
  }

  /** Drops the cached copy of an asset (used when an upload fails after the model was loaded). */
  forgetAsset(assetId: string) {
    const template = this.templates.get(assetId)
    if (!template) return
    this.disposeObject(template)
    this.templates.delete(assetId)
  }

  duplicateEntity(id: string) {
    const source = this.entities.get(id)
    if (!source) return
    const object = source.kind === 'model' ? cloneSkinned(source.object) : this.makePrimitive(source.kind)
    object.position.copy(source.object.position).x += 1
    object.rotation.copy(source.object.rotation)
    object.scale.copy(source.object.scale)
    const copy = this.register({
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
      kind: source.kind,
      assetId: source.assetId,
      components: structuredClone(source.components),
      object,
    })
    this.select(copy)
  }

  async loadScene(data: SceneData, resolve: AssetResolver) {
    this.silent = true
    try {
      this.clear()
      for (const e of data.entities) {
        let object: THREE.Object3D | null = null
        if (e.kind === 'model') {
          if (e.assetId) {
            try {
              const assetId = e.assetId
              const template = await this.template(assetId, () => resolve(assetId))
              if (template) object = cloneSkinned(template)
            } catch {
              object = null
            }
          }
          if (!object) object = this.makePlaceholder()
        } else {
          object = this.makePrimitive(e.kind)
        }
        object.position.set(...e.position)
        object.rotation.set(e.rotation[0] * DEG, e.rotation[1] * DEG, e.rotation[2] * DEG)
        object.scale.set(...e.scale)
        this.register({ id: e.id, name: e.name, kind: e.kind, assetId: e.assetId, components: e.components ?? {}, object })
      }
    } finally {
      this.silent = false
      this.invalidate()
      this.emit()
    }
  }

  updateEntity(id: string, patch: Partial<Pick<EntityData, 'name' | 'position' | 'rotation' | 'scale' | 'components'>>) {
    const e = this.entities.get(id)
    if (!e) return
    if (patch.name !== undefined) e.name = patch.name
    if (patch.components) e.components = patch.components
    if (patch.position) e.object.position.set(...patch.position)
    if (patch.rotation) {
      e.object.rotation.set(patch.rotation[0] * DEG, patch.rotation[1] * DEG, patch.rotation[2] * DEG)
    }
    if (patch.scale) e.object.scale.set(...patch.scale)
    this.invalidate()
    this.emit()
  }

  removeEntity(id: string) {
    const e = this.entities.get(id)
    if (!e) return
    if (this.selectedId === id) this.select(null)
    this.scene.remove(e.object)
    if (e.kind !== 'model') this.disposeObject(e.object)
    this.entities.delete(id)
    this.invalidate()
    this.emit()
  }

  select(id: string | null) {
    this.selectedId = id && this.entities.has(id) ? id : null
    if (this.selectedId) this.transform.attach(this.entities.get(this.selectedId)!.object)
    else this.transform.detach()
    this.invalidate()
    this.emit()
  }

  setMode(mode: TransformMode) {
    this.mode = mode
    this.transform.setMode(mode)
    this.invalidate()
    this.emit()
  }

  // ---- play mode ----------------------------------------------------------

  /** Starts the game: builds a Rapier physics world from the scene and runs entity scripts. */
  async startPlay() {
    if (this.play || this.starting) return
    this.starting = true
    try {
      if (!this.rapier) {
        this.rapier = (await import('@dimforge/rapier3d-compat')).default
        await this.rapier.init()
      }
      const RAPIER = this.rapier
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
      const bodies = new Map<string, PlayBody>()
      const initial: PlayState['initial'] = new Map()
      this.select(null)

      for (const e of this.entities.values()) {
        const o = e.object
        initial.set(e.id, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })
        const rb = e.components.rigidbody
        if (!rb) continue
        const desc =
          rb.type === 'dynamic'
            ? RAPIER.RigidBodyDesc.dynamic()
            : rb.type === 'kinematic'
              ? RAPIER.RigidBodyDesc.kinematicPositionBased()
              : RAPIER.RigidBodyDesc.fixed()
        desc.setTranslation(o.position.x, o.position.y, o.position.z)
        desc.setRotation({ x: o.quaternion.x, y: o.quaternion.y, z: o.quaternion.z, w: o.quaternion.w })
        const body = world.createRigidBody(desc)
        const { half, center } = this.localBounds(o)
        const shape =
          e.kind === 'sphere'
            ? RAPIER.ColliderDesc.ball(Math.max(half.x, half.y, half.z))
            : RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        shape.setTranslation(center.x, center.y, center.z).setRestitution(0.2).setFriction(0.6)
        world.createCollider(shape, body)
        bodies.set(e.id, { body, type: rb.type, object: o })
      }

      const scripts: ScriptInstance[] = []
      const keys = this.keys
      const input = { key: (code: string) => keys.has(code) }
      const find = (name: string) => {
        const target = [...this.entities.values()].find((x) => x.name === name)
        return target ? this.scriptApi(target, bodies) : null
      }
      for (const e of this.entities.values()) {
        const code = e.components.script?.code
        if (!code?.trim()) continue
        const instance: ScriptInstance = { name: e.name, start: null, update: null, failed: false }
        try {
          const factory = new Function(
            'self',
            'input',
            'THREE',
            'find',
            'log',
            `${code}\n;return { start: typeof start === 'function' ? start : null, update: typeof update === 'function' ? update : null }`,
          )
          const hooks = factory(
            this.scriptApi(e, bodies),
            input,
            THREE,
            find,
            (...args: unknown[]) => this.onLog('log', `[${e.name}] ${args.map(String).join(' ')}`),
          ) as Pick<ScriptInstance, 'start' | 'update'>
          instance.start = hooks.start
          instance.update = hooks.update
        } catch (err) {
          instance.failed = true
          this.onLog('error', `[${e.name}] ${err instanceof Error ? err.message : String(err)}`)
        }
        scripts.push(instance)
      }

      this.play = { world, bodies, scripts, initial, last: performance.now() / 1000, accumulator: 0, time: 0 }
      this.playing = true
      this.transform.enabled = false
      for (const s of scripts) if (!s.failed && s.start) this.guard(s, () => s.start!())
      this.emit()
    } catch (err) {
      this.onLog('error', `Could not start the game: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    } finally {
      this.starting = false
    }
  }

  /** Stops the game and puts every object back where it was before Play. */
  stopPlay() {
    const play = this.play
    if (!play) return
    this.play = null
    this.playing = false
    play.world.free()
    for (const [id, snap] of play.initial) {
      const e = this.entities.get(id)
      if (!e) continue
      e.object.position.copy(snap.p)
      e.object.quaternion.copy(snap.q)
      e.object.scale.copy(snap.s)
    }
    this.transform.enabled = true
    this.invalidate()
    this.emit()
  }

  private tick(play: PlayState) {
    const now = performance.now() / 1000
    const dt = Math.min(now - play.last, 0.1)
    play.last = now
    play.time += dt

    for (const s of play.scripts) {
      if (!s.failed && s.update) this.guard(s, () => s.update!(dt, play.time))
    }
    for (const b of play.bodies.values()) {
      if (b.type !== 'kinematic') continue
      const p = b.object.position
      const q = b.object.quaternion
      b.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
      b.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    }

    const step = 1 / 60
    play.accumulator += dt
    let steps = 0
    while (play.accumulator >= step && steps < 5) {
      play.world.step()
      play.accumulator -= step
      steps++
    }
    if (steps === 5) play.accumulator = 0

    for (const b of play.bodies.values()) {
      if (b.type !== 'dynamic') continue
      const t = b.body.translation()
      const r = b.body.rotation()
      b.object.position.set(t.x, t.y, t.z)
      b.object.quaternion.set(r.x, r.y, r.z, r.w)
    }
  }

  private guard(script: ScriptInstance, fn: () => void) {
    try {
      fn()
    } catch (err) {
      script.failed = true
      this.onLog('error', `[${script.name}] ${err instanceof Error ? err.message : String(err)} (script stopped)`)
    }
  }

  /** The object a script sees as `self` (and returns from `find`). */
  private scriptApi(e: Entity, bodies: Map<string, PlayBody>) {
    const o = e.object
    return {
      name: e.name,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      velocity: () => {
        const v = bodies.get(e.id)?.body.linvel()
        return { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 }
      },
      setVelocity: (x: number, y: number, z: number) => bodies.get(e.id)?.body.setLinvel({ x, y, z }, true),
      addImpulse: (x: number, y: number, z: number) => bodies.get(e.id)?.body.applyImpulse({ x, y, z }, true),
      teleport: (x: number, y: number, z: number) => {
        o.position.set(x, y, z)
        bodies.get(e.id)?.body.setTranslation({ x, y, z }, true)
      },
    }
  }

  /** Size and offset of an object's bounds in its own (unrotated) space, for colliders. */
  private localBounds(o: THREE.Object3D) {
    const p = o.position.clone()
    const q = o.quaternion.clone()
    o.position.set(0, 0, 0)
    o.quaternion.identity()
    o.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(o)
    o.position.copy(p)
    o.quaternion.copy(q)
    o.updateMatrixWorld(true)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const half = new THREE.Vector3(Math.max(size.x / 2, 0.001), Math.max(size.y / 2, 0.001), Math.max(size.z / 2, 0.001))
    return { half, center }
  }

  // ---- internals ----------------------------------------------------------

  private async template(assetId: string, url: () => Promise<string | null>): Promise<THREE.Object3D | null> {
    const cached = this.templates.get(assetId)
    if (cached) return cached
    const resolved = await url()
    if (!resolved) return null
    const root = (await this.gltf.loadAsync(resolved)).scene
    this.templates.set(assetId, root)
    return root
  }

  private register(entity: Omit<Entity, 'components'> & { components?: Components }): string {
    entity.object.userData.entityId = entity.id
    this.scene.add(entity.object)
    this.entities.set(entity.id, { ...entity, components: entity.components ?? {} })
    this.invalidate()
    this.emit()
    return entity.id
  }

  private clear() {
    this.select(null)
    for (const e of this.entities.values()) {
      this.scene.remove(e.object)
      if (e.kind !== 'model') this.disposeObject(e.object)
    }
    this.entities.clear()
  }

  private makePrimitive(kind: EntityKind): THREE.Object3D {
    const geometry = kind === 'sphere' ? new THREE.SphereGeometry(0.5, 32, 16) : new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({ color: 0x7d93ff, roughness: 0.5, metalness: 0.1 })
    return new THREE.Mesh(geometry, material)
  }

  /** Shown when a model asset cannot be loaded, so the scene keeps its layout. */
  private makePlaceholder(): THREE.Object3D {
    const material = new THREE.MeshBasicMaterial({ color: 0xff6b6b, wireframe: true })
    return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  }

  private countTriangles(root: THREE.Object3D): number {
    let total = 0
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const geometry = mesh.geometry
      total += geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count ?? 0) / 3
    })
    return Math.round(total)
  }

  private disposeObject(root: THREE.Object3D) {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose()
        }
        material.dispose()
      }
    })
  }

  private invalidate() {
    this.dirty = true
  }

  private emit() {
    if (this.silent) return
    this.listeners.forEach((fn) => fn())
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    if (this.play) {
      this.tick(this.play)
      this.dirty = true
    }
    if (!this.dirty) return
    this.dirty = false
    this.renderer.render(this.scene, this.camera)
  }

  private resize() {
    const w = Math.max(this.host.clientWidth, 1)
    const h = Math.max(this.host.clientHeight, 1)
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }

  private onPointerUp = (e: PointerEvent) => {
    const start = this.downAt
    this.downAt = null
    if (!start || this.play || this.transform.dragging || this.transform.axis !== null) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return

    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const targets = [...this.entities.values()].map((entity) => entity.object)
    const hit = this.raycaster.intersectObjects(targets, true)[0]
    let picked: string | null = null
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.entityId) {
        picked = o.userData.entityId as string
        break
      }
    }
    this.select(picked)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.keys.clear()
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.play) {
      this.keys.add(e.code)
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
      return
    }
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      if (this.selectedId) this.duplicateEntity(this.selectedId)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key.toLowerCase()) {
      case 'w':
        this.setMode('translate')
        break
      case 'e':
        this.setMode('rotate')
        break
      case 'r':
        this.setMode('scale')
        break
      case 'delete':
        if (this.selectedId) this.removeEntity(this.selectedId)
        break
    }
  }
}
