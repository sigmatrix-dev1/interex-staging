/// <reference types="vite/client" />
/// <reference types="@remix-run/node" />

interface ImportMetaEnv {
	readonly LOCKOUT_MAX_ATTEMPTS?: string
	readonly LOCKOUT_WINDOW_SECONDS?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
