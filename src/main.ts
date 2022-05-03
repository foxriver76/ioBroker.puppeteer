import * as utils from '@iobroker/adapter-core';
import puppeteer, { Page, Browser, ScreenshotOptions, ScreenshotClip } from 'puppeteer';
import { isObject } from './lib/tools';

class PuppeteerAdapter extends utils.Adapter {
    private browser: Browser | undefined;
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
        this.subscribeStates('url');
        this.browser = await puppeteer.launch({ headless: true });
        this.log.info('Ready to take screenshots');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
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
     * Is called when message received
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

            try {
                const page = await this.browser.newPage();

                await page.goto(url, { waitUntil: 'networkidle2' });

                // if wait options given, await them
                if (waitMethod && waitMethod in page) {
                    await (page as any)[waitMethod](waitParameter);
                }

                const img = await page.screenshot(options);

                this.sendTo(obj.from, obj.command, { result: img }, obj.callback);
            } catch (e) {
                this.log.error(`Could not take screenshot of "${url}": ${e.message}`);
                this.sendTo(obj.from, obj.command, { error: e }, obj.callback);
            }
        } else {
            this.log.error(`Unsupported message command: ${obj.command}`);
            this.sendTo(
                obj.from,
                obj.command,
                { error: new Error(`Unsupported message command: ${obj.command}`) },
                obj.callback
            );
        }
    }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        // user wants to perform a screenshot
        if (state && state.val && !state.ack) {
            const options: ScreenshotOptions = await this.gatherScreenshotOptions();

            if (!options.path) {
                this.log.error('Please specify a filename before taking a screenshot');
                return;
            }

            this.log.debug(`Screenshot options: ${JSON.stringify(options)}`);
            this.log.info(`Taking screenshot of "${state.val}"`);

            try {
                const page = await this.browser.newPage();
                await page.goto(state.val as string, { waitUntil: 'networkidle2' });

                await this.waitForConditions(page);

                await page.screenshot(options);

                // set ack true, to inform about screenshot creation
                this.log.info('Screenshot sucessfully saved');
                await this.setStateAsync(id, state.val, true);
                await page.close();
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
            this.log.debug('Ingoring clip options, because full page is desired');
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
            clipWidth: 'width'
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
            await page.waitForTimeout(renderTimeMs);
            return;
        }
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
