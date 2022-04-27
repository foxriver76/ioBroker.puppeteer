import * as utils from '@iobroker/adapter-core';
import puppeteer from 'puppeteer';
import { Browser, ScreenshotOptions, ScreenshotClip } from 'puppeteer';

class PuppeteerAdapter extends utils.Adapter {
    private browser: Browser | undefined;
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'puppeteer' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        this.subscribeStates('url');
        this.log.info('ready');
        this.browser = await puppeteer.launch({ headless: true });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private async onUnload(callback: () => void): Promise<void> {
        this.log.info('shutting down');
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = undefined;
            }
            callback();
        } catch {
            callback();
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
                await page.screenshot(options);
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
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PuppeteerAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new PuppeteerAdapter())();
}
