// Vercel entry point.
//
// The Vercel Node runtime invokes the module's default export as (req, res) -
// which is exactly an Express app's own signature, so no adapter is needed here.
// Every path is routed to this file by the rewrite in vercel.json; static assets
// under public/ are served from the CDN before the rewrite is consulted.
module.exports = require("../server.js");
