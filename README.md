# Web Game Maker

A browser-based 3D game editor. Projects, scenes and 3D models live in Supabase; the viewport renders with WebGL2 (Three.js).

## What works today (v0.1)

- Sign up, sign in and sign out (Supabase Auth)
- A saved list of all your projects (create, open, delete)
- Editor with a WebGL2 viewport, orbit camera, scene hierarchy, inspector, and move/rotate/scale gizmos (hotkeys W, E, R, Delete)
- Add cubes and spheres, and import your own `.glb` 3D models (Draco and Meshopt compressed files are supported)
- Models upload to a private Supabase Storage bucket; asset metadata (size, triangle count) is stored in the database
- A model library per project: import once, add it to a scene as many times as you like. Copies share one loaded copy of the geometry and materials, so repeats cost little memory (Ctrl+D duplicates the selection)
- Play mode: press Play to run the scene with Rapier physics (dynamic, static and kinematic bodies) and per-object JavaScript scripts with a `start` and `update` function; Stop restores the scene exactly
- Scenes autosave to the database and reload with the project
- Render-on-demand: the GPU only draws a frame when something changes

## Setup

```bash
npm install          # also creates package-lock.json; commit it so CI can use `npm ci`
cp .env.example .env # then fill in your Supabase URL and publishable key
npm run dev
```

The database schema lives in `supabase/migrations/`. It creates profiles, projects, scenes, assets, project_versions and builds tables with Row Level Security (users can only access their own rows), plus the private `project-assets` and `build-artifacts` storage buckets.

In the Supabase dashboard, review Authentication settings: email confirmation, redirect URLs for your deployed site, and rate limits.

## Project layout

```
src/engine/Engine.ts    WebGL2 viewport, selection, gizmos, scene (de)serialisation
src/components/         Auth page, project dashboard, editor
src/lib/                Supabase client, session hook, types
supabase/migrations/    SQL schema and RLS policies
.github/workflows/      CI: typecheck and build
```

See `docs/FEATURES.md` for the full feature tracker.

**Script safety:** scripts run in your browser with full page access. Only run projects you trust until sandboxed execution is added.

## Roadmap

1. Performance: instancing, automatic LOD generation, BVH picking, Web Worker model decoding, KTX2 textures
2. ECS runtime (bitECS), scripting (Monaco + TypeScript), Rapier physics (Wasm), Web Audio
3. Materials, lighting and post-processing; terrain, vegetation and UI layout tools
4. Export: web build first, then Windows and macOS (Tauri) and Android (Capacitor) built by GitHub Actions
5. Version history, real-time collaboration, asset marketplace

WebGPU-only features (hardware ray tracing) are planned as an optional mode; the default renderer stays WebGL2.
