"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var extension_exports = {};
__export(extension_exports, {
  default: () => PuppeteerWebExtension
});
module.exports = __toCommonJS(extension_exports);
const MESSAGE_TIMEOUT_MS = 12e4;
const CONTENT_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};
function toBuffer(result) {
  if (!result) {
    return null;
  }
  if (typeof result === "string") {
    return Buffer.from(result, "base64");
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
  if (typeof result === "object") {
    const asBuffer = result;
    if (asBuffer.type === "Buffer" && Array.isArray(asBuffer.data)) {
      return Buffer.from(asBuffer.data);
    }
  }
  return null;
}
function toBoolean(value, defaultValue) {
  if (value === void 0) {
    return defaultValue;
  }
  return value !== "false" && value !== "0";
}
function toNumber(value) {
  if (value === void 0) {
    return void 0;
  }
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
function describeError(error) {
  var _a;
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  const message = error == null ? void 0 : error.message;
  if (typeof message === "string") {
    return message;
  }
  try {
    return (_a = JSON.stringify(error)) != null ? _a : String(error);
  } catch {
    return "unknown error";
  }
}
class PuppeteerWebExtension {
  /**
   * Called by `ioBroker.web` - the argument list is its extension contract.
   *
   * @param _server the http(s) server of the web instance, unused here
   * @param _webSettings settings of the web instance (secure, port, auth, ...), unused here
   * @param adapter the web adapter instance this extension runs in
   * @param instanceSettings the instance object of the puppeteer instance this extension belongs to
   * @param app the express app of the web instance
   */
  constructor(_server, _webSettings, adapter, instanceSettings, app) {
    this.unloaded = false;
    var _a;
    this.app = app;
    this.adapter = adapter;
    this.namespace = instanceSettings ? instanceSettings._id.substring("system.adapter.".length) : "puppeteer";
    const config = (instanceSettings == null ? void 0 : instanceSettings.native) || {};
    const path = (config.webPath || this.namespace).toString().replace(/^\/+|\/+$/g, "");
    this.route = `/${path || this.namespace}`;
    const webInstance = (_a = config.webInstance) != null ? _a : "*";
    if (webInstance !== "*" && webInstance !== adapter.namespace) {
      this.unloaded = true;
      this.adapter.log.debug(`Puppeteer extension of ${this.namespace} is configured for "${webInstance}"`);
      return;
    }
    this.adapter.log.info(`Install puppeteer extension on "${this.route}/"`);
    this.app.use(this.route, (req, res, next) => {
      if (this.unloaded) {
        next();
        return;
      }
      this.onRequest(req, res).catch((e) => {
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
  unload() {
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
  async onRequest(req, res) {
    const query = req.query;
    const { url } = query;
    if (!url) {
      res.status(400).json({ error: "Missing required parameter: url" });
      return;
    }
    if (!isHttpUrl(url)) {
      res.status(400).json({ error: "Parameter url must be an absolute http(s) URL" });
      return;
    }
    const encoding = query.encoding === "base64" ? "base64" : "binary";
    const type = query.type === "jpeg" || query.type === "jpg" ? "jpeg" : query.type === "webp" ? "webp" : "png";
    const message = {
      url,
      type,
      // the image travels through the states database, so ask for the compact representation
      ioBrokerOptions: { encoding: "base64" }
    };
    const width = toNumber(query.width);
    const height = toNumber(query.height);
    if (width || height) {
      message.viewportOptions = { width: width != null ? width : 1280, height: height != null ? height : 720 };
    }
    const fullPage = toBoolean(query.fullPage, false);
    if (fullPage) {
      message.fullPage = true;
    }
    const clipLeft = toNumber(query.clipLeft);
    const clipTop = toNumber(query.clipTop);
    const clipWidth = toNumber(query.clipWidth);
    const clipHeight = toNumber(query.clipHeight);
    if (!fullPage && clipLeft !== void 0 && clipTop !== void 0 && clipWidth && clipHeight) {
      message.clip = { x: clipLeft, y: clipTop, width: clipWidth, height: clipHeight };
    }
    const quality = toNumber(query.quality);
    if (quality !== void 0) {
      message.quality = quality;
    }
    if (query.omitBackground !== void 0) {
      message.omitBackground = toBoolean(query.omitBackground);
    }
    if (query.captureBeyondViewport !== void 0) {
      message.captureBeyondViewport = toBoolean(query.captureBeyondViewport);
    }
    if (query.waitUntil) {
      message.waitUntil = query.waitUntil;
    }
    if (query.navigationTimeout) {
      message.navigationTimeout = query.navigationTimeout;
    }
    if (query.waitForSelector) {
      message.waitOption = { waitForSelector: query.waitForSelector };
    } else if (query.waitForTimeout) {
      message.waitOption = { waitForTimeout: toNumber(query.waitForTimeout) };
    }
    this.adapter.log.debug(`[${this.namespace}] Requesting screenshot of "${url}"`);
    const answer = await this.sendToAdapter("screenshot", message);
    if (answer == null ? void 0 : answer.error) {
      throw new Error(describeError(answer.error));
    }
    const img = toBuffer(answer == null ? void 0 : answer.result);
    if (!(img == null ? void 0 : img.length)) {
      throw new Error(`No screenshot from ${this.namespace} - see the adapter log for the reason`);
    }
    if (encoding === "base64") {
      res.json({ result: img.toString("base64") });
    } else {
      res.setHeader("Content-Type", CONTENT_TYPES[type]);
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
  sendToAdapter(command, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No answer from ${this.namespace} within ${MESSAGE_TIMEOUT_MS} ms`));
      }, MESSAGE_TIMEOUT_MS);
      try {
        this.adapter.sendTo(this.namespace, command, message, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }
}
//# sourceMappingURL=extension.js.map
