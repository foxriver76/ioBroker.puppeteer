// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Additional args for puppeteer launch */
            additionalArgs: { Argument: string }[];
            /** If an external browser should be used, specified by `executablePath` */
            useExternalBrowser: boolean;
            /** Optional executable path to use external browser */
            executablePath: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
