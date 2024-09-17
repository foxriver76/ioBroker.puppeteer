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
var import_tools = require("./lib/tools");
var import_path = require("path");
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
    let additionalArgs;
    if (this.config.additionalArgs) {
      additionalArgs = this.config.additionalArgs.map((entry) => entry.Argument);
    }
    this.log.debug(`Additional arguments: ${JSON.stringify(additionalArgs)}`);
    this.browser = await import_puppeteer.default.launch({
      headless: true,
      defaultViewport: null,
      args: additionalArgs
    });
    this.subscribeStates("url");
    this.log.info("Ready to take screenshots");
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
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
   * Is called when message received
   *
   * @param obj the ioBroker message object
   */
  async onMessage(obj) {
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
      const { storagePath } = PuppeteerAdapter.extractIoBrokerOptionsFromMessage(options);
      const viewport = PuppeteerAdapter.extractViewportOptionsFromMessage(options);
      try {
        if (options.path) {
          this.validatePath(options.path);
        }
        const page = await this.browser.newPage();
        if (viewport) {
          await page.setViewport(viewport);
        }
        await page.goto(url, { waitUntil: "networkidle2" });
        if (waitMethod && waitMethod in page) {
          await page[waitMethod](waitParameter);
        }
        const img = await page.screenshot(options);
        if (storagePath) {
          this.log.debug(`Write file to "${storagePath}"`);
          await this.writeFileAsync("0_userdata.0", storagePath, Buffer.from(img));
        }
        await page.close();
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
   *
   * @param id id of the changed state
   * @param state the state object
   */
  async onStateChange(id, state) {
    if (!this.browser) {
      return;
    }
    if (state && state.val && !state.ack) {
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
        const page = await this.browser.newPage();
        await page.goto(state.val, { waitUntil: "networkidle2" });
        await this.waitForConditions(page);
        await page.screenshot(options);
        this.log.info("Screenshot sucessfully saved");
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
      this.log.debug("Ingoring clip options, because full page is desired");
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
    path = (0, import_path.resolve)((0, import_path.normalize)(path));
    this.log.debug(`Checking path "${path}"`);
    if (path.startsWith(utils.getAbsoluteDefaultDataDir())) {
      throw new Error("Screenshots cannot be stored inside the ioBroker storage");
    }
    if (path.includes(`${import_path.sep}node_modules${import_path.sep}`)) {
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
   * Extracts the ioBroker specific options from the message
   *
   * @param options obj.message part of a message passed by user
   */
  static extractIoBrokerOptionsFromMessage(options) {
    var _a;
    let storagePath;
    if (typeof ((_a = options.ioBrokerOptions) == null ? void 0 : _a.storagePath) === "string") {
      storagePath = options.ioBrokerOptions.storagePath;
    }
    delete options.ioBrokerOptions;
    return { storagePath };
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
