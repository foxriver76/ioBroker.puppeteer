var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target, mod));
var utils = __toESM(require("@iobroker/adapter-core"));
const puppeteer = require("puppeteer");
class PuppeteerAdapter extends utils.Adapter {
  constructor(options = {}) {
    super(__spreadProps(__spreadValues({}, options), { name: "puppeteer" }));
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    this.subscribeStates("url");
    this.log.info("ready");
    this.browser = await puppeteer.launch({ headless: true });
  }
  async onUnload(callback) {
    this.log.info("shutting down");
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = void 0;
      }
      callback();
    } catch {
      callback();
    }
  }
  async onStateChange(_id, state) {
    if (!this.browser) {
      return;
    }
    if (state && state.val) {
      const options = {};
      const filenameState = await this.getStateAsync("filename");
      if (filenameState && filenameState.val) {
        options.path = filenameState.val;
      } else {
        this.log.warn("Please specify a filename before taking screenshots");
      }
      this.log.info(`Taking screenshot of "${state.val}"`);
      try {
        const page = await this.browser.newPage();
        await page.goto(state.val, { waitUntil: "networkidle2" });
        await page.screenshot(options);
        this.log.info("Screenshot sucessfully saved");
      } catch (e) {
        this.log.error(`Could not take screenshot of "${state.val}": ${e.message}`);
      }
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new PuppeteerAdapter(options);
} else {
  (() => new PuppeteerAdapter())();
}
//# sourceMappingURL=main.js.map
