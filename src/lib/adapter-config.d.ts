// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /**
             * Additional command-line arguments passed to the Puppeteer browser on launch.
             * Each entry must contain an `Argument` string (e.g. `--no-sandbox`).
             */
            additionalArgs: { Argument: string }[];

            /**
             * When `true`, Puppeteer uses the browser binary defined by `executablePath`
             * instead of the bundled Chromium version.
             */
            useExternalBrowser: boolean;

            /**
             * Absolute path to an external browser executable (e.g. `/usr/bin/google-chrome`).
             * Only relevant when `useExternalBrowser` is `true`.
             */
            executablePath: string;

            /**
             * Instance of `ioBroker.web` this adapter registers its web extension with,
             * e.g. `web.0`. `*` (default) means every web instance.
             */
            webInstance?: string;

            /**
             * URL path the web extension is served under, e.g. `puppeteer` results in
             * `http://<web-ip>:8082/puppeteer/?url=...`. Must be unique per instance.
             */
            webPath?: string;

            /**
             * Maximum number of parallel renders (screenshots/pages active).
             * 0 means unlimited (default). Used to save RAM.
             */
            maxParallelRenders?: number;
        }
    }
}

// this is required, so the above AdapterConfig is found by TypeScript / type checking
export {};
