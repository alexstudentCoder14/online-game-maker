# Feature tracker

Status: done, in progress, planned. Groups follow the original feature list.

## Editor and interface
- [x] Cloud-saved projects, autosave, project list
- [x] Scene hierarchy, inspector, viewport with move/rotate/scale gizmos
- [x] Hotkeys that avoid browser defaults (W, E, R, Delete, Ctrl+D)
- [ ] Docking layouts, light/dark themes, configurable shortcuts
- [ ] Undo/redo, multi-select, prefabs and parent/child nesting
- [ ] Version history UI (table exists), real-time collaboration

## Rendering (WebGL2 default, WebGPU optional)
- [x] WebGL2 renderer, render-on-demand, shared geometry for repeated models
- [ ] GPU instancing for repeated meshes, automatic LOD, occlusion culling, BVH picking
- [ ] PBR material editor, lights, shadows, post-processing stack, particles
- [ ] Visual shader builder, decals, volumetric fog, custom render passes
- [ ] Virtual texturing, WebGPU ray tracing (WebGPU only)

## Assets
- [x] GLB import (Draco and Meshopt supported), private cloud storage, per-project model library
- [ ] Texture, audio and other file types; drag-and-drop; tagging and search UI
- [ ] Server-side optimisation (mesh compression, texture resize, audio transcode)
- [ ] FBX and OBJ conversion; asset marketplace

## Scripting and logic
- [x] Per-object JavaScript scripts (start and update), console output, input, physics helpers
- [ ] Monaco editor with TypeScript and autocomplete, hot reload, debugger
- [ ] Visual node scripting, entity component system (bitECS), spawn/destroy at runtime
- [ ] Sandboxed script execution before sharing or publishing games (scripts currently run with full page access)

## Physics, AI, animation, audio
- [x] Rapier physics: dynamic, static and kinematic bodies with box and sphere colliders, gravity
- [ ] Mesh colliders, joints, triggers and collision events, raycasts, 2D physics, debug overlay
- [ ] NavMesh, state machine AI editor
- [ ] Animation clips, blend trees, timeline editor
- [ ] Web Audio: 3D sound, mixer, synthesis, analysis, microphone input

## World building and UI
- [ ] Terrain sculpting, vegetation, roads, procedural cities, voxels
- [ ] Flexbox UI designer, rich text, SVG, localisation, UI events

## Build and publish
- [ ] Web export and CDN publish
- [ ] Windows and macOS (Tauri), Android (Capacitor) via GitHub Actions
- [ ] Multiplayer relay (WebRTC), analytics, monetisation SDKs
