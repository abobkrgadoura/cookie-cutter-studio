# Cutter Studio

Web-based 3D cookie cutter and stamp generator. React + Vite + Tailwind CSS v4 + Three.js (`@react-three/fiber`, `@react-three/drei`).

Cookiecad-inspired editor: landing upload, settings sidebar, live 3D preview with dimension overlays. Geometry is a parametric heart placeholder so sidebar values can be tested before Potrace / Clipper tracing.

## Run

```bash
npm install
npm run dev
```

## Folder structure

```
src/
  App.jsx
  main.jsx
  index.css
  context/          Theme + cutter settings state
  lib/              Units helpers + heart silhouette
  views/            Landing and editor layouts
  components/
    layout/Header.jsx
    ui/             NumberField, Select, Toggle, Checkbox
    sidebar/        Accordion sections (CenterBars, CutterWallText, …)
    viewer/         Canvas, mesh, dimensions, wall text
```

## Notes

- Internal units are millimeters. Inch mode converts for display and input.
- Changing size, blade, handle, sharp, center bars, or wall text rebuilds the placeholder mesh.
- Image tracing is not implemented yet; uploads set aspect ratio and open the editor.
