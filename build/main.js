"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_puppeteer = __toESM(require("puppeteer"));
var import_node_path = require("node:path");
var import_tools = require("./lib/tools");
const VALID_WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"];
const DEFAULT_WAIT_UNTIL = "networkidle2";
const DEFAULT_NAVIGATION_TIMEOUT_MS = 3e4;
class AsyncQueue {
  constructor(maxConcurrent) {
    this.queue = [];
    this.activeCount = 0;
    const parsed = Number(maxConcurrent);
    this.maxConcurrent = Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 0;
  }
  async add(task) {
    if (this.maxConcurrent === 0) {
      return task();
    }
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise((resolve2) => this.queue.push(resolve2));
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
  constructor(options = {}) {
    super({ ...options, name: "puppeteer" });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    const args = ["--no-sandbox", "--disable-setuid-sandbox"];
    this.renderQueue = new AsyncQueue(this.config.maxParallelRenders || 0);
    if (this.config.additionalArgs) {
      for (const entry of this.config.additionalArgs) {
        if (!args.includes(entry.Argument)) {
          args.push(entry.Argument);
        }
      }
    }
    this.log.debug(`Launch arguments: ${JSON.stringify(args)}`);
    this.browser = await import_puppeteer.default.launch({
      headless: true,
      defaultViewport: null,
      executablePath: this.config.useExternalBrowser ? this.config.executablePath : void 0,
      args
    });
    this.subscribeStates("url");
    this.log.info("Ready to take screenshots");
  }
  /**
   * Is called when the adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback callback which needs to be called
   */
  async onUnload(callback) {
    try {
      if (this.browser) {
        this.log.info("Closing browser");
        await this.browser.close();
        this.browser = void 0;
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
  async onMessage(obj) {
    var _a, _b;
    if (!this.browser) {
      return;
    }
    this.log.debug(`Message: ${JSON.stringify(obj)}`);
    if (obj.command === "screenshot") {
      let url;
      let options;
      if (typeof obj.message === "string") {
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
      const waitUntil = (_a = PuppeteerAdapter.parseWaitUntil(options.waitUntil)) != null ? _a : DEFAULT_WAIT_UNTIL;
      const navigationTimeout = (_b = PuppeteerAdapter.parseNavigationTimeout(options.navigationTimeout)) != null ? _b : DEFAULT_NAVIGATION_TIMEOUT_MS;
      delete options.waitUntil;
      delete options.navigationTimeout;
      try {
        if (options.path) {
          this.validatePath(options.path);
        }
        await this.renderQueue.add(async () => {
          let page;
          let img;
          let error;
          try {
            page = await this.browser.newPage();
            page.setDefaultTimeout(navigationTimeout);
            if (viewport) {
              await page.setViewport(viewport);
            }
            await page.goto(url, { waitUntil, timeout: navigationTimeout });
            if (waitMethod === "waitForTimeout") {
              await this.delay(Number(waitParameter) || 0);
            } else if (waitMethod && waitMethod in page) {
              await page[waitMethod](waitParameter);
            }
            img = await page.screenshot(options);
            if (storagePath) {
              this.log.debug(`Write file to "${storagePath}"`);
              await this.writeFileAsync("0_userdata.0", storagePath, Buffer.from(img));
            }
          } catch (e) {
            error = e.message;
            this.log.error(`Could not take screenshot of "${url}": ${e.message}`);
          } finally {
            await PuppeteerAdapter.safeClosePage(page);
          }
          this.sendTo(
            obj.from,
            obj.command,
            error ? { error: { message: error } } : { result: img && encoding === "base64" ? Buffer.from(img).toString("base64") : img },
            obj.callback
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
        obj.callback
      );
    }
  }
  /**
   * Is called if a subscribed state changes
   *
   * @param id id of the changed state
   * @param state the state object
   */
  async onStateChange(id, state) {
    if (!this.browser) {
      return;
    }
    if ((state == null ? void 0 : state.val) && !state.ack) {
      const options = await this.gatherScreenshotOptions();
      if (!options.path) {
        this.log.error("Please specify a filename before taking a screenshot");
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
        await this.renderQueue.add(async () => {
          let page;
          try {
            page = await this.browser.newPage();
            await page.goto(state.val, { waitUntil: DEFAULT_WAIT_UNTIL });
            await this.waitForConditions(page);
            await page.screenshot(options);
            this.log.info("Screenshot successfully saved");
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
  async gatherScreenshotOptions() {
    const options = {};
    const filenameState = await this.getStateAsync("filename");
    if (filenameState && filenameState.val) {
      options.path = filenameState.val;
    }
    const fullPageState = await this.getStateAsync("fullPage");
    if (fullPageState) {
      options.fullPage = !!fullPageState.val;
    }
    if (!options.fullPage) {
      const clipOptions = await this.gatherScreenshotClipOptions();
      if (clipOptions) {
        options.clip = clipOptions;
      }
    } else {
      this.log.debug("Ignoring clip options, because full page is desired");
    }
    return options;
  }
  /**
   * Determines the ScreenshotClipOptions by the current configuration states
   */
  async gatherScreenshotClipOptions() {
    const options = {};
    const clipAttributes = {
      clipLeft: "x",
      clipTop: "y",
      clipHeight: "height",
      clipWidth: "width"
    };
    for (const [id, attributeName] of Object.entries(clipAttributes)) {
      const clipAttributeState = await this.getStateAsync(id);
      if (clipAttributeState && typeof clipAttributeState.val === "number") {
        options[attributeName] = clipAttributeState.val;
      } else {
        this.log.debug(`Ignoring clip, because "${id}" is not configured`);
        return;
      }
    }
    return options;
  }
  /**
   * Validates that the given path is valid to save a screenshot too, prevents node_modules and dataDir
   *
   * @param path path to check
   */
  validatePath(path) {
    path = (0, import_node_path.resolve)((0, import_node_path.normalize)(path));
    this.log.debug(`Checking path "${path}"`);
    if (path.startsWith(utils.getAbsoluteDefaultDataDir())) {
      throw new Error("Screenshots cannot be stored inside the ioBroker storage");
    }
    if (path.includes(`${import_node_path.sep}node_modules${import_node_path.sep}`)) {
      throw new Error("Screenshots cannot be stored inside a node_modules folder");
    }
  }
  /**
   * Waits until the user configured conditions are fullfilled
   *
   * @param page active page object
   */
  async waitForConditions(page) {
    var _a, _b;
    const selector = (_a = await this.getStateAsync("waitForSelector")) == null ? void 0 : _a.val;
    if (selector && typeof selector === "string") {
      this.log.debug(`Waiting for selector "${selector}"`);
      await page.waitForSelector(selector);
      return;
    }
    const renderTimeMs = (_b = await this.getStateAsync("renderTime")) == null ? void 0 : _b.val;
    if (renderTimeMs && typeof renderTimeMs === "number") {
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
  static parseWaitUntil(value) {
    if (typeof value !== "string") {
      return void 0;
    }
    return VALID_WAIT_UNTIL.includes(value) ? value : void 0;
  }
  /**
   * Parses a candidate `navigationTimeout` value (ms) from a query string or message.
   * Accepts numbers or numeric strings; returns `undefined` for missing/non-positive input.
   *
   * @param value raw value as provided by the caller
   */
  static parseNavigationTimeout(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
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
  static async safeClosePage(page) {
    if (!page) {
      return;
    }
    try {
      await page.close();
    } catch {
    }
  }
  /**
   * Extracts the ioBroker specific options from the message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractIoBrokerOptionsFromMessage(options) {
    var _a, _b;
    let storagePath;
    if (typeof ((_a = options.ioBrokerOptions) == null ? void 0 : _a.storagePath) === "string") {
      storagePath = options.ioBrokerOptions.storagePath;
    }
    const encoding = ((_b = options.ioBrokerOptions) == null ? void 0 : _b.encoding) === "base64" ? "base64" : void 0;
    delete options.ioBrokerOptions;
    return { storagePath, encoding };
  }
  /**
   * Extracts the viewport specific options from the message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractViewportOptionsFromMessage(options) {
    let viewportOptions;
    if ((0, import_tools.isObject)(options.viewportOptions) && typeof options.viewportOptions.width === "number" && typeof options.viewportOptions.height === "number") {
      viewportOptions = options.viewportOptions;
    }
    delete options.viewportOptions;
    return viewportOptions;
  }
  /**
   * Extracts the waitOption from a message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractWaitOptionFromMessage(options) {
    let waitMethod;
    let waitParameter;
    if ("waitOption" in options) {
      if ((0, import_tools.isObject)(options.waitOption)) {
        waitMethod = Object.keys(options.waitOption)[0];
        waitParameter = Object.values(options.waitOption)[0];
      }
      delete options.waitOption;
    }
    return { waitMethod, waitParameter };
  }
}
if (require.main !== module) {
  module.exports = (options) => new PuppeteerAdapter(options);
} else {
  (() => new PuppeteerAdapter())();
}
//# sourceMappingURL=main.js.map
