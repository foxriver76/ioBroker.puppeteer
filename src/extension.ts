/**
 * Web extension for `ioBroker.web`.
 *
 * This file does NOT run in the puppeteer adapter process - `ioBroker.web` requires it and
 * instantiates the default export, handing over its own express app. The browser therefore lives
 * in another process, so every screenshot is requested from the adapter via `sendTo` instead of
 * being rendered here.
 *
 * Because the routes are installed on the web adapter's app, they automatically inherit its
 * http/https scheme and its authentication - the extension needs no port, no certificates and no
 * OAuth2 handling of its own.
 */
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Express, Request, Response, NextFunction } from 'express';

/**
 * A browser is waiting on the other end, so a silent adapter must not hang the request forever.
 * Generous, because a screenshot legitimately takes as long as `navigationTimeout` (30 s by default)
 * plus the time the request may spend queued behind `maxParallelRenders`.
 */
const MESSAGE_TIMEOUT_MS = 120_000;

const CONTENT_TYPES: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

interface WebSettings {
    secure: boolean;
    port: number;
    language?: ioBroker.Languages;
    defaultUser?: string;
    auth?: boolean;
}

interface ScreenshotAnswer {
    result?: unknown;
    error?: unknown;
}

/**
 * Turns whatever the adapter answered into a Buffer.
 *
 * The extension asks for `base64`, but a `sendTo` answer can still arrive in other shapes: in
 * compact mode both adapters share a process and the raw `Uint8Array` is passed by reference, while
 * a `Buffer` that travelled through the states database arrives as `{ type: 'Buffer', data: [] }`.
 *
 * @param result the `result` property of the adapter's answer
 */
function toBuffer(result: unknown): Buffer | null {
    if (!result) {
        return null;
    }
    if (typeof result === 'string') {
        return Buffer.from(result, 'base64');
    }
    if (Buffer.isBuffer(result)) {
        return result;
    }
    if (result instanceof Uint8Array) {
        return Buffer.from(result);
    }
    if (Array.isArray(result)) {
        return Buffer.from(result);
    }
    if (typeof result === 'object') {
        const asBuffer = result as { type?: string; data?: number[] };
        if (asBuffer.type === 'Buffer' && Array.isArray(asBuffer.data)) {
            return Buffer.from(asBuffer.data);
        }
    }
    return null;
}

/**
 * Reads a boolean from a query parameter.
 *
 * @param value raw query value
 * @param defaultValue value to use when the parameter is absent
 */
function toBoolean(value: unknown, defaultValue?: boolean): boolean | undefined {
    if (value === undefined) {
        return defaultValue;
    }
    return value !== 'false' && value !== '0';
}

/**
 * Reads a number from a query parameter.
 *
 * @param value raw query value
 */
function toNumber(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = parseFloat(value as string);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Checks that a query parameter is an absolute http(s) URL.
 *
 * @param value raw query value
 */
function isHttpUrl(value: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Turns whatever was thrown or answered into something readable.
 *
 * `String(new Error('...'))` is fine, but an error that travelled through the states database is a
 * plain object, and `String({})` is `[object Object]` - exactly the information the caller needs is
 * then gone.
 *
 * @param error the caught or answered value
 */
function describeError(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        return error.message;
    }
    const message = (error as { message?: unknown })?.message;
    if (typeof message === 'string') {
        return message;
    }
    try {
        return JSON.stringify(error) ?? String(error);
    } catch {
        return 'unknown error';
    }
}

/**
 * The web extension itself.
 *
 * `ioBroker.web` instantiates this class once per puppeteer instance that points at it and passes
 * its own express app in, so all this has to do is install a route and forward the requests.
 */
export default class PuppeteerWebExtension {
    private readonly app: Express;
    /** The `ioBroker.web` adapter instance this extension was loaded into */
    private readonly adapter: ioBroker.Adapter;
    /** Namespace of the puppeteer instance this extension belongs to, e.g. `puppeteer.0` */
    private readonly namespace: string;
    private readonly route: string;
    private unloaded = false;

    /**
     * Called by `ioBroker.web` - the argument list is its extension contract.
     *
     * @param _server the http(s) server of the web instance, unused here
     * @param _webSettings settings of the web instance (secure, port, auth, ...), unused here
     * @param adapter the web adapter instance this extension runs in
     * @param instanceSettings the instance object of the puppeteer instance this extension belongs to
     * @param app the express app of the web instance
     */
    public constructor(
        _server: HttpServer | HttpsServer,
        _webSettings: WebSettings,
        adapter: ioBroker.Adapter,
        instanceSettings: ioBroker.InstanceObject,
        app: Express,
    ) {
        this.app = app;
        this.adapter = adapter;
        this.namespace = instanceSettings ? instanceSettings._id.substring('system.adapter.'.length) : 'puppeteer';

        const config = (instanceSettings?.native || {}) as ioBroker.AdapterConfig;
        // Several puppeteer instances can extend the same web instance, so the path must be free to change
        const path = (config.webPath || this.namespace).toString().replace(/^\/+|\/+$/g, '');
        this.route = `/${path || this.namespace}`;

        // ioBroker.web already loads only extensions whose webInstance matches - checked again, so the
        // extension never answers on a web instance it was not configured for
        const webInstance = config.webInstance ?? '*';
        if (webInstance !== '*' && webInstance !== adapter.namespace) {
            this.unloaded = true;
            this.adapter.log.debug(`Puppeteer extension of ${this.namespace} is configured for "${webInstance}"`);
            return;
        }

        this.adapter.log.info(`Install puppeteer extension on "${this.route}/"`);

        this.app.use(this.route, (req: Request, res: Response, next: NextFunction): void => {
            if (this.unloaded) {
                next();
                return;
            }
            this.onRequest(req, res).catch(e => {
                const message = describeError(e);
                this.adapter.log.error(`Cannot take screenshot: ${message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: message });
                }
            });
        });
    }

    /**
     * Called by `ioBroker.web` when it shuts down.
     *
     * Express cannot un-register a route, so the handler stays installed and is made inert instead.
     */
    public unload(): Promise<void> {
        this.unloaded = true;
        return Promise.resolve();
    }

    /**
     * GET `<route>/?url=...`
     *
     * Takes a screenshot of the given URL and returns the image. All parameters are passed as query
     * string parameters - the same ones the message API accepts, so links keep working unchanged:
     *
     * - `url` {string} REQUIRED - The full URL of the page to screenshot (e.g. https://example.com).
     * - `width` / `height` {number} Size of the browser viewport in pixels (defaults: 1280 / 720).
     * - `fullPage` {boolean} "true" or "1" captures the entire scrollable page.
     * - `clipLeft` / `clipTop` / `clipWidth` / `clipHeight` {number} Crop region in px. All four are
     *   required, and the whole region is ignored when `fullPage=true`.
     * - `quality` {number} JPEG/WebP compression quality between 0 and 100. No effect for PNG.
     * - `omitBackground` {boolean} "true" or "1" gives a transparent background. PNG only.
     * - `encoding` {"base64"|"binary"} "base64" answers JSON `{ result: "<base64string>" }`,
     *   "binary" answers raw image bytes (default).
     * - `captureBeyondViewport` {boolean} "false" or "0" restricts the screenshot to the viewport
     *   (default: true).
     * - `waitForSelector` {string} CSS selector to wait for. Takes priority over `waitForTimeout`.
     * - `waitForTimeout` {number} Milliseconds to wait after page load. Only used without a selector.
     * - `type` {"png"|"jpeg"|"webp"} Image format (default: "png").
     * - `waitUntil` {"load"|"domcontentloaded"|"networkidle0"|"networkidle2"} When navigation counts
     *   as finished (default: "networkidle2").
     * - `navigationTimeout` {number} Maximum time in ms for `page.goto()` and subsequent waits
     *   (default: 30000).
     *
     * @param req the express request
     * @param res the express response
     */
    private async onRequest(req: Request, res: Response): Promise<void> {
        const query = req.query as Record<string, string | undefined>;
        const { url } = query;

        if (!url) {
            res.status(400).json({ error: 'Missing required parameter: url' });
            return;
        }
        // Reachable over the network, so do not let it open file://, chrome:// and similar in the browser
        if (!isHttpUrl(url)) {
            res.status(400).json({ error: 'Parameter url must be an absolute http(s) URL' });
            return;
        }

        const encoding: 'base64' | 'binary' = query.encoding === 'base64' ? 'base64' : 'binary';
        const type = query.type === 'jpeg' || query.type === 'jpg' ? 'jpeg' : query.type === 'webp' ? 'webp' : 'png';

        // Everything that is not an ioBrokerOption is forwarded to `page.screenshot()` by the adapter
        const message: Record<string, unknown> = {
            url,
            type,
            // the image travels through the states database, so ask for the compact representation
            ioBrokerOptions: { encoding: 'base64' },
        };

        const width = toNumber(query.width);
        const height = toNumber(query.height);
        if (width || height) {
            message.viewportOptions = { width: width ?? 1280, height: height ?? 720 };
        }

        const fullPage = toBoolean(query.fullPage, false);
        if (fullPage) {
            message.fullPage = true;
        }

        const clipLeft = toNumber(query.clipLeft);
        const clipTop = toNumber(query.clipTop);
        const clipWidth = toNumber(query.clipWidth);
        const clipHeight = toNumber(query.clipHeight);
        if (!fullPage && clipLeft !== undefined && clipTop !== undefined && clipWidth && clipHeight) {
            message.clip = { x: clipLeft, y: clipTop, width: clipWidth, height: clipHeight };
        }

        const quality = toNumber(query.quality);
        if (quality !== undefined) {
            message.quality = quality;
        }
        if (query.omitBackground !== undefined) {
            message.omitBackground = toBoolean(query.omitBackground);
        }
        if (query.captureBeyondViewport !== undefined) {
            message.captureBeyondViewport = toBoolean(query.captureBeyondViewport);
        }
        if (query.waitUntil) {
            message.waitUntil = query.waitUntil;
        }
        if (query.navigationTimeout) {
            message.navigationTimeout = query.navigationTimeout;
        }

        // waitForSelector has priority, exactly as in the message API
        if (query.waitForSelector) {
            message.waitOption = { waitForSelector: query.waitForSelector };
        } else if (query.waitForTimeout) {
            message.waitOption = { waitForTimeout: toNumber(query.waitForTimeout) };
        }

        this.adapter.log.debug(`[${this.namespace}] Requesting screenshot of "${url}"`);

        const answer = (await this.sendToAdapter('screenshot', message)) as ScreenshotAnswer;

        if (answer?.error) {
            throw new Error(describeError(answer.error));
        }

        const img = toBuffer(answer?.result);
        if (!img?.length) {
            throw new Error(`No screenshot from ${this.namespace} - see the adapter log for the reason`);
        }

        if (encoding === 'base64') {
            res.json({ result: img.toString('base64') });
        } else {
            res.setHeader('Content-Type', CONTENT_TYPES[type]);
            res.send(img);
        }
    }

    /**
     * `sendTo` with a timeout.
     *
     * Unlike an HTTP request, a message to a stopped adapter is simply never answered - without this
     * the browser request would hang until the browser itself gives up.
     *
     * @param command the message command
     * @param message the payload
     */
    private sendToAdapter(command: string, message: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`No answer from ${this.namespace} within ${MESSAGE_TIMEOUT_MS} ms`));
            }, MESSAGE_TIMEOUT_MS);

            try {
                this.adapter.sendTo(this.namespace, command, message, answer => {
                    clearTimeout(timer);
                    resolve(answer);
                });
            } catch (e) {
                clearTimeout(timer);
                reject(e as Error);
            }
        });
    }
}
