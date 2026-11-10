/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute/relative base URL of the data bundle (default: ./data/). e.g. an R2 bucket. */
  readonly VITE_DATA_URL?: string;
  /** Optional MapLibre style URL to replace the built-in monochrome OpenFreeMap basemap. */
  readonly VITE_BASEMAP_STYLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
