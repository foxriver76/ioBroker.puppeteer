import * as utils from '@iobroker/adapter-core';
import type { Page, Browser, ScreenshotOptions, ScreenshotClip, Viewport, PuppeteerLifeCycleEvent } from 'puppeteer';
import puppeteer from 'puppeteer';
import { normalize, resolve, sep as pathSeparator } from 'node:path';
import { isObject } from './lib/tools';

const VALID_WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] as const;
const DEFAULT_WAIT_UNTIL: PuppeteerLifeCycleEvent = 'networkidle2';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

class AsyncQueue {
    private queue: (() => void)[] = [];
    private activeCount = 0;
    private readonly maxConcurrent: number;

    constructor(maxConcurrent: unknown) {
        // A negative or garbage value (manual config edit) would otherwise block the queue forever
        const parsed = Number(maxConcurrent);
        this.maxConcurrent = Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 0;
    }

    public async add<T>(task: () => Promise<T>): Promise<T> {
        if (this.maxConcurrent === 0) {
            return task(); // No limit
        }

        if (this.activeCount >= this.maxConcurrent) {
            await new Promise<void>(resolve => this.queue.push(resolve));
        }

        this.activeCount++;
        try {
            return await task();
        } finally {
            this.activeCount--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                if (next) {
                    next();
                }
            }
        }
    }
}

class PuppeteerAdapter extends utils.Adapter {
    private browser: Browser | undefined;
    private renderQueue: AsyncQueue | undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'puppeteer' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Chrome needs to run without its sandbox on most ioBroker hosts (Docker,
        // root, and modern Linux distros that restrict unprivileged user namespaces
        // via AppArmor - otherwise the browser process fails to launch).
        const args = ['--no-sandbox', '--disable-setuid-sandbox'];

        this.renderQueue = new AsyncQueue(this.config.maxParallelRenders || 0);

        if (this.config.additionalArgs) {
            for (const entry of this.config.additionalArgs) {
                if (!args.includes(entry.Argument)) {
                    args.push(entry.Argument);
                }
            }
        }

        this.log.debug(`Launch arguments: ${JSON.stringify(args)}`);

        this.browser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            executablePath: this.config.useExternalBrowser ? this.config.executablePath : undefined,
            args,
        });
        this.subscribeStates('url');
        this.log.info('Ready to take screenshots');
    }

    /**
     * Is called when the adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback callback which needs to be called
     */
    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.browser) {
                this.log.info('Closing browser');
                await this.browser.close();
                this.browser = undefined;
            }
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Is called when a message received
     *
     * @param obj the ioBroker message object
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        this.log.debug(`Message: ${JSON.stringify(obj)}`);

        if (obj.command === 'screenshot') {
            let url: string;
            let options: Record<string, any>;

            if (typeof obj.message === 'string') {
                url = obj.message;
                options = {};
            } else {
                url = obj.message.url;
                options = obj.message;
                delete options.url;
            }

            const { waitMethod, waitParameter } = PuppeteerAdapter.extractWaitOptionFromMessage(options);
            const { storagePath, encoding } = PuppeteerAdapter.extractIoBrokerOptionsFromMessage(options);
            const viewport = PuppeteerAdapter.extractViewportOptionsFromMessage(options);
            const waitUntil = PuppeteerAdapter.parseWaitUntil(options.waitUntil) ?? DEFAULT_WAIT_UNTIL;
            const navigationTimeout =
                PuppeteerAdapter.parseNavigationTimeout(options.navigationTimeout) ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
            delete options.waitUntil;
            delete options.navigationTimeout;

            try {
                if (options.path) {
                    this.validatePath(options.path);
                }

                await this.renderQueue!.add(async () => {
                    let page: Page | undefined;
                    let img: Uint8Array | undefined;
                    let error: string | undefined;
                    try {
                        page = await this.browser!.newPage();
                        // Bound subsequent ops (waitForSelector, screenshot, …) so they cannot hang forever.
                        page.setDefaultTimeout(navigationTimeout);

                        if (viewport) {
                            await page.setViewport(viewport);
                        }

                        await page.goto(url, { waitUntil, timeout: navigationTimeout });

                        // if wait options given, await them
                        if (waitMethod === 'waitForTimeout') {
                            // Page.waitForTimeout no longer exists in puppeteer, so wait here instead
                            await this.delay(Number(waitParameter) || 0);
                        } else if (waitMethod && waitMethod in page) {
                            await (page as any)[waitMethod](waitParameter);
                        }

                        img = await page.screenshot(options);
                        if (storagePath) {
                            this.log.debug(`Write file to "${storagePath}"`);
                            await this.writeFileAsync('0_userdata.0', storagePath, Buffer.from(img));
                        }
                    } catch (e) {
                        error = e.message;
                        this.log.error(`Could not take screenshot of "${url}": ${e.message}`);
                    } finally {
                        await PuppeteerAdapter.safeClosePage(page);
                    }

                    // A plain object, because an Error loses its message when serialized through the states database
                    this.sendTo(
                        obj.from,
                        obj.command,
                        error
                            ? { error: { message: error } }
                            : { result: img && encoding === 'base64' ? Buffer.from(img).toString('base64') : img },
                        obj.callback,
                    );
                });
            } catch (e) {
                this.log.error(`Could not take screenshot of "${url}": ${e.message}`);
                this.sendTo(obj.from, obj.command, { error: { message: e.message } }, obj.callback);
            }
        } else {
            this.log.error(`Unsupported message command: ${obj.command}`);
            this.sendTo(
                obj.from,
                obj.command,
                { error: new Error(`Unsupported message command: ${obj.command}`) },
                obj.callback,
            );
        }
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param id id of the changed state
     * @param state the state object
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        // user wants to perform a screenshot
        if (state?.val && !state.ack) {
            const options: ScreenshotOptions = await this.gatherScreenshotOptions();

            if (!options.path) {
                this.log.error('Please specify a filename before taking a screenshot');
                return;
            }

            try {
                this.validatePath(options.path);
            } catch (e) {
                this.log.error(`Cannot take screenshot: ${e.message}`);
                return;
            }

            this.log.debug(`Screenshot options: ${JSON.stringify(options)}`);
            this.log.info(`Taking screenshot of "${state.val}"`);

            try {
                await this.renderQueue!.add(async () => {
                    let page: Page | undefined;
                    try {
                        page = await this.browser!.newPage();
                        await page.goto(state.val as string, { waitUntil: DEFAULT_WAIT_UNTIL });

                        await this.waitForConditions(page);

                        await page.screenshot(options);

                        // set ack true to inform about screenshot creation
                        this.log.info('Screenshot successfully saved');
                        await this.setStateAsync(id, state.val, true);
                    } catch (e) {
                        this.log.error(`Could not take screenshot of "${state.val}": ${e.message}`);
                    } finally {
                        await PuppeteerAdapter.safeClosePage(page);
                    }
                });
            } catch (e) {
                this.log.error(`Could not take screenshot of "${state.val}": ${e.message}`);
            }
        }
    }

    /**
     * Determines the ScreenshotOptions by the current configuration states
     */
    private async gatherScreenshotOptions(): Promise<ScreenshotOptions> {
        const options: ScreenshotOptions = {};

        // get the path
        const filenameState = await this.getStateAsync('filename');
        if (filenameState && filenameState.val) {
            options.path = filenameState.val as string;
        }

        // check fullPage flag
        const fullPageState = await this.getStateAsync('fullPage');
        if (fullPageState) {
            options.fullPage = !!fullPageState.val;
        }

        if (!options.fullPage) {
            const clipOptions: ScreenshotClip | void = await this.gatherScreenshotClipOptions();

            if (clipOptions) {
                options.clip = clipOptions;
            }
        } else {
            this.log.debug('Ignoring clip options, because full page is desired');
        }

        return options;
    }

    /**
     * Determines the ScreenshotClipOptions by the current configuration states
     */
    private async gatherScreenshotClipOptions(): Promise<ScreenshotClip | void> {
        const options: Partial<ScreenshotClip> = {};

        const clipAttributes = {
            clipLeft: 'x',
            clipTop: 'y',
            clipHeight: 'height',
            clipWidth: 'width',
        } as const;

        for (const [id, attributeName] of Object.entries(clipAttributes)) {
            const clipAttributeState = await this.getStateAsync(id);
            if (clipAttributeState && typeof clipAttributeState.val === 'number') {
                options[attributeName] = clipAttributeState.val;
            } else {
                this.log.debug(`Ignoring clip, because "${id}" is not configured`);
                return;
            }
        }

        return options as ScreenshotClip;
    }

    /**
     * Validates that the given path is valid to save a screenshot too, prevents node_modules and dataDir
     *
     * @param path path to check
     */
    private validatePath(path: string): void {
        path = resolve(normalize(path));
        this.log.debug(`Checking path "${path}"`);

        if (path.startsWith(utils.getAbsoluteDefaultDataDir())) {
            throw new Error('Screenshots cannot be stored inside the ioBroker storage');
        }

        if (path.includes(`${pathSeparator}node_modules${pathSeparator}`)) {
            throw new Error('Screenshots cannot be stored inside a node_modules folder');
        }
    }

    /**
     * Waits until the user configured conditions are fullfilled
     *
     * @param page active page object
     */
    private async waitForConditions(page: Page): Promise<void> {
        // selector has highest priority
        const selector = (await this.getStateAsync('waitForSelector'))?.val;
        if (selector && typeof selector === 'string') {
            this.log.debug(`Waiting for selector "${selector}"`);
            await page.waitForSelector(selector);
            return;
        }

        const renderTimeMs = (await this.getStateAsync('renderTime'))?.val;
        if (renderTimeMs && typeof renderTimeMs === 'number') {
            this.log.debug(`Waiting for timeout "${renderTimeMs}" ms`);
            await this.delay(renderTimeMs);
            return;
        }
    }

    /**
     * Parses a candidate `waitUntil` value (from query string or message) and returns
     * a valid `PuppeteerLifeCycleEvent`, or `undefined` if the value is missing/invalid.
     *
     * @param value raw value as provided by the caller
     */
    private static parseWaitUntil(value: unknown): PuppeteerLifeCycleEvent | undefined {
        if (typeof value !== 'string') {
            return undefined;
        }
        return (VALID_WAIT_UNTIL as readonly string[]).includes(value) ? (value as PuppeteerLifeCycleEvent) : undefined;
    }

    /**
     * Parses a candidate `navigationTimeout` value (ms) from a query string or message.
     * Accepts numbers or numeric strings; returns `undefined` for missing/non-positive input.
     *
     * @param value raw value as provided by the caller
     */
    private static parseNavigationTimeout(value: unknown): number | undefined {
        const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    /**
     * Closes a page and swallows any errors.
     *
     * Why: page.close() can reject when the renderer or browser is already gone (e.g. after an OOM kill
     * or a navigation crash). A throw here would bubble out of the finally block and skip the caller's
     * own error handling, which is exactly what previously caused renderer processes to leak.
     *
     * @param page page to close (maybe undefined if newPage() itself failed)
     */
    private static async safeClosePage(page: Page | undefined): Promise<void> {
        if (!page) {
            return;
        }
        try {
            await page.close();
        } catch {
            // ignore — the renderer is gone or already closing
        }
    }

    /**
     * Extracts the ioBroker specific options from the message
     *
     * @param options obj.message part of a message passed by user
     */
    private static extractIoBrokerOptionsFromMessage(options: Record<string, any>): {
        storagePath: string | undefined;
        encoding: 'base64' | undefined;
    } {
        let storagePath: string | undefined;
        if (typeof options.ioBrokerOptions?.storagePath === 'string') {
            storagePath = options.ioBrokerOptions.storagePath;
        }

        // The web extension asks for base64: the image travels through the states database as JSON,
        // where a raw Uint8Array degenerates into a map of indices that is several times the size.
        const encoding = options.ioBrokerOptions?.encoding === 'base64' ? 'base64' : undefined;

        delete options.ioBrokerOptions;
        return { storagePath, encoding };
    }

    /**
     * Extracts the viewport specific options from the message
     *
     * @param options obj.message part of a message passed by user
     */
    private static extractViewportOptionsFromMessage(options: Record<string, any>): Viewport | undefined {
        let viewportOptions: Viewport | undefined;
        if (
            isObject(options.viewportOptions) &&
            typeof options.viewportOptions.width === 'number' &&
            typeof options.viewportOptions.height === 'number'
        ) {
            viewportOptions = options.viewportOptions as Viewport;
        }

        delete options.viewportOptions;
        return viewportOptions;
    }

    /**
     * Extracts the waitOption from a message
     *
     * @param options obj.message part of a message passed by user
     */
    private static extractWaitOptionFromMessage(options: Record<string, any>): {
        waitMethod: string | undefined;
        waitParameter: unknown;
    } {
        let waitMethod: string | undefined;
        let waitParameter: unknown;

        if ('waitOption' in options) {
            if (isObject(options.waitOption)) {
                waitMethod = Object.keys(options.waitOption)[0];
                waitParameter = Object.values(options.waitOption)[0];
            }
            delete options.waitOption;
        }

        return { waitMethod, waitParameter };
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PuppeteerAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new PuppeteerAdapter())();
}
