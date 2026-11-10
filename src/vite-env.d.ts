/// <reference types="vite/client" />

declare const __LUMON_BUILD__: string

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_WS_BASE_URL: string
  readonly VITE_CLOUDINARY_CLOUD_NAME: string
  readonly VITE_CLOUDINARY_UPLOAD_PRESET: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
