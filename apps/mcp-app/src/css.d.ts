// `main.tsx` imports `./styles.css` for its side effect, which Vite understands
// and TypeScript does not: since TS 5.7 a side-effect import with no type
// declaration is TS2882 rather than a silent pass, so `npm run typecheck` fails
// on a tree nobody has touched.
//
// Declared here rather than by referencing `vite/client`, because this is the
// only thing the app needs from it: `import.meta.env` is already read through
// an explicit cast (diagnostics.ts#builtWithDiagnostics), and pulling in the
// whole client typing would make the typecheck depend on vite being installed
// for a file that imports a stylesheet.
declare module "*.css";
