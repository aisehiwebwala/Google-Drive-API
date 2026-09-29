// Netlify entry point.
//
// Netlify Functions are Lambda-shaped (event, context), so unlike Vercel the
// Express app needs an adapter. serverless-http translates the Lambda event into
// a Node req/res pair and collects the response.
//
// `binary` is left at its default: every response this app produces is text
// (HTML, JSON, CSS, JS), and public/ is served from the CDN rather than through
// the function, so there is no binary body to base64-encode.
const serverless = require("serverless-http");
const app = require("../../server.js");

module.exports.handler = serverless(app);
