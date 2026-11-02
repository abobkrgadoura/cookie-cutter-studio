# Cookie Cutter Engine — Engineering TODO

Cross-referenced against `vectorizer.js`, `svgParser.js`, `cutterGeometry.js`, `manifoldEngine.js`, `geometryWorker.js`, `ModelContext.jsx`, and `.cursorrules`.

## Phase 1: 2D Path Resolution & Smoothing

### 1.1 SVG tessellation (`svgParser.js`)
- [x] Replace the global `shape.getPoints(divisions = 128)` cap with **adaptive, chord-error sampling**.
- [x] Sample each `Path`/`Shape` curve independently by **arc length**.
- [x] Raise the DOM-fallback circle from a hard `count = 128` to the same adaptive sampler.
- [x] Move SVG parse off the main thread into `geometryWorker`.
- [x] Normalize SVG winding to the engine convention (**outer = positive area, holes = negative**).

### 1.2 Raster destaircase / Chaikin (`vectorizer.js`)
- [x] Verify `chaikinShortEdges` actually densifies **long residual chords**.
- [x] Split the sharp-corner pin from the chord cut.
- [x] Rename / split `chaikinShortEdges` so the API matches behavior.
- [x] Add a **max chord length in traced-px** so Chaikin passes cannot explode vertex count.
- [x] Audit RDP `RDP_SIMPLIFY_TOLERANCE_PX = 0.9` vs. 1:1 cavity rule.
- [x] Recompute `computeSharpCorners` after each Chaikin pass but **freeze the original sharp index set**.

### 1.3 No premature decimation before extrusion
- [x] Stop `isolateOuterContour` from running `simplifyPolygonPaths` on the **cutter cavity**.
- [x] Keep stamp-only `robustSimplifyPaths(..., GEOMETRY_CLEAN_TOLERANCE_MM)` off the cutter cavity path.
- [x] Do **not** reconnect `sanitizeCutterWall` to the cutter pipeline.
- [x] Ban any post-fit RDP / Chaikin / Laplacian on `cutterCavityPaths`.
- [x] Confirm `offsetCavity` never feeds `robustSimplifyPaths`.
- [x] Align preset tessellation with SVG density (`generateHeartPoints` matches the SVG sampler).

### 1.4 Rule 1 / Rule 6 gates
- [x] Path-integrity check (0.02 mm): ensure strict dimensional accuracy natively. Do NOT show warning messages to the user about design complexity; handle precision silently in the background.

---

## Phase 2: 3D Geometry Profile Perfection

### 2.1 Rectangular handle — vertical Z-block + Round XY (`cutterGeometry.js`)
- [x] Rectangular Z-profile is a 90° block.
- [x] Default `JoinType.Round` keeps filleted XY corners.
- [x] Keep the same-Z inward shoulder from being counted as a taper.

### 2.2 Round handle — true capsule (RZ stadium)
- [x] True capsule / stadium in the RZ plane.
- [x] Fillet **into the blade wall** (`bladeOuter`).
- [x] Drive the capsule with explicit control points.
- [x] Capsule construction is overlapping manifold prisms only.
- [x] Clamp `filletRadius = min(handleWidth/2, handleHeight/2)`.

### 2.3 Chamfer handle + blade taper
- [x] `finalizeGeometry` crease: blade/handle **80°**; bars/stamp stay **40°**.
- [x] Chamfer is a single linear RZ ramp (`buildStraightChamferGeometry`).
- [x] Sharp blade stays control points only (ray-cast shell).
- [x] Rule 3 overlap (`STACK_OVERLAP_MM = 0.01`).
- [x] Inner wall of blade and handle stays the un-offset cavity.

### 2.4 CSG assembly & Rule 2
- [x] Union blade + handle into **one manifold solid** before preview/export.
- [x] Wall text is a manifold glyph extrusion, boolean-unioned into the blade.
- [x] Clipper2 is **2D booleans only**. Volumetric CSG stays in `manifoldEngine.js`.

### 2.5 Stamp base-plate shading
- [x] Backing plate and raised imprint are independent manifold extrusions that overlap by 0.05 mm.

---

## Phase 3: Visual Rendering & Performance

### 3.1 WASM heap
- [x] Every `CrossSection` / `Manifold` / `Mesh` exit path goes through `wasmDelete`.
- [x] `solid.getMesh()` copies `vertProperties` / `triVerts`, then deletes the mesh handle.
- [x] `getWasmLeakCount()` tracks live handles. Each generate job opens a `beginWasmScope()`; `sweepWasmScope()` deletes anything that job still owns, including solids left by a failed union or difference.
- [x] Failed batch unions delete the unused operand and fall back to pairwise union.

### 3.2 Studio Matte + lighting (`CutterMesh.jsx` / `Viewer3D.jsx`)
- [x] Studio Matte is a single material factory.
- [x] Key / fill / rim lighting.
- [x] `castShadow` on the key light.
- [x] `ContactShadows` sit on the build plate (Z = 0).

### 3.3 GPU memory
- [x] `ModelContext.disposeModel` runs when a model is replaced.
- [x] Worker `disposeModel` after a transferable `postMessage` does not touch detached `ArrayBuffer`s.
- [x] A skipped or failed job disposes its Three.js meshes in the worker `finally`.

---

## Phase 4: Export & System Stability

### 4.1 Zero-copy ArrayBuffer transfer
- [x] `packPaths` + `collectPathTransferables` in `generateModelInWorker`.
- [x] `TRACE_RESULT` paths use the same packing.
- [x] Slider ticks send `extractGeometryPayload`, not the full settings object.

### 4.2 Debounce + AbortController
- [x] `ModelContext` passes `{ signal }`.
- [x] Abort rejects the client promise with `AbortError` and drops the pending id.
- [x] The previous controller is aborted when a new build starts.
- [x] The worker is recreated on `onerror`.
- [x] Pointer-down batches one build on release; pointer-up edits wait 50 ms.
- [x] Superseded `GENERATE_MODEL` ids are skipped at each yield. The in-flight job's meshes and WASM scope are released before the next job builds.

### 4.3 Export
- [x] STL, OBJ, and 3MF download from one export group. Stencil sheets also download SVG.
- [x] Watertight check (open edges, non-manifold edges, inverted volume) blocks the download.
- [x] Blade, handle, bars, and wall text are one shell. `model.wallText` is not a second mesh.
- [x] Stamp Z matches `computeStampZ(settings)` in the viewer and the export.

### 4.4 Scaling & worker contract
- [x] Rule 6: `fitInnerCavityPaths` runs first, then absolute millimetre offsets.
- [x] Each job echoes `id`. A superseded id posts `MODEL_SKIPPED` and does not leave WASM handles alive.

---

## Phase 5: Product features

### 5.1 Text-on-path and engraving
- [x] Cutter wall text follows the outer wall (font, weight, size, letter spacing, curve resolution, perimeter position) and is boolean-unioned into the blade.
- [x] Add an SVG import field dedicated to the Stamp mode, allowing users to import an SVG and toggle it as either Emboss (raised) or Deboss (engraved) on the stamp base.

### 5.2 Dimension overlays
- [x] Dimension-line toggle.
- [x] Theme-aware width, height, and area rulers in the 3D view.

### 5.3 Tracing and import
- [x] Threshold and invert controls for raster traces.
- [x] SVG parse errors surface as toasts.
- [x] Drag-and-drop and clipboard paste of images and SVG files.

### 5.4 Editor chrome
- [x] Canvas entity and stencil bridge undo/redo operational inside `VectorEditorContext`.

---

## Phase 6: Cloud SaaS

- [x] Cloud accounts (Supabase auth).
- [x] Cloud library (Supabase `designs`).
- [x] Monetization (Paymob / Paddle billing). Tested and integrated.
- [x] Mobile responsiveness (responsive layout, touch bounds, drawer/bottom sheet).
- [x] Toast notifications for save, export, and image-process failures.

---

## Phase 7: Advanced Features & UX Milestones

### 7.1 Stencil Undo/Redo & History
- [x] Stencil bridge drawing tool wired into the main `VectorEditorContext` history stack.

### 7.2 Advanced 2D Editor Tools
- [x] Copy/Paste: Drawn shapes/entities copy and paste cleanly.
- [x] Grouping: Multiple shapes merge into a single entity group.

### 7.3 UI/UX Enhancements
- [x] Technical tooltips limited strictly to complex manufacturing terms with overflow bounds fixed.
- [x] Full mobile responsive viewport with interactive bottom sheet and drawers.

### 7.4 Export & Integrations
- [x] Client-side STEP download (AP214 faceted solid) supporting CNC manufacturing workflows alongside STL, OBJ, and 3MF.

---

## 📦 Future Product Backlog (Deferred)
- [ ] **Full Project State Save (Cloud):** Persist raw tracing vectors and canvas entity JSON alongside profile settings in Supabase.