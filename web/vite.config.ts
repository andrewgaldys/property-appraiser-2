import { defineConfig } from 'vite';

// `base: './'` makes every asset URL relative, so the same build works at
// https://<user>.github.io/<repo>/, a custom domain, or any sub-folder.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    // maplibre-gl is ~1 MB minified on its own; that is expected.
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      output: {
        // Emit the MapLibre worker as .js: some static hosts serve .mjs with a non-JavaScript
        // MIME type, and a module worker refuses to start when that happens.
        assetFileNames: (asset: { names?: string[] }) =>
          asset.names?.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
