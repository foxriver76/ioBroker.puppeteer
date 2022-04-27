import * as utils from '@iobroker/adapter-core';
//import * as puppeteer from 'puppeteer';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = require('puppeteer');
import { Browser, ScreenshotOptions } from 'puppeteer';

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
    private async onStateChange(_id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!this.browser) {
            // unload called
            return;
        }

        // user wants to perform a screenshot
        if (state && state.val) {
            const options: ScreenshotOptions = {};
            // get the path
            const filenameState = await this.getStateAsync('filename');
            if (filenameState && filenameState.val) {
                options.path = filenameState.val as string;
            } else {
                this.log.warn('Please specify a filename before taking screenshots');
            }

            this.log.info(`Taking screenshot of "${state.val}"`);

            try {
                const page = await this.browser.newPage();

                await page.goto(state.val as string, { waitUntil: 'networkidle2' });
                await page.screenshot(options);
                this.log.info('Screenshot sucessfully saved');
            } catch (e) {
                this.log.error(`Could not take screenshot of "${state.val}": ${e.message}`);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PuppeteerAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new PuppeteerAdapter())();
}
