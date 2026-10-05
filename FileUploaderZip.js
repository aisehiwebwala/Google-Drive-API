const { google } = require("googleapis");
const { Readable, PassThrough } = require("stream");
const { spawn } = require('child_process');
const zlib = require('zlib');
const unzipper = require('unzipper');

const dotenv = require("dotenv");
dotenv.config();

const firebase_utils = require("./firebase/utils");

const authClient = new google.auth.OAuth2({
    client_id: process.env.client_id,
    client_secret: process.env.client_secret
});
authClient.setCredentials({ refresh_token: process.env.refresh_token });

const drive = google.drive({ version: 'v3', auth: authClient });
const parentFolderId = process.env.parentFolderId;

async function getFileInfo(_url, customHeaders) {
    try {
        const response = await fetch(_url, { method: "HEAD", headers: { ...customHeaders } });
        if (response.status === 426) return null;
        return { 
            "contentType": response.headers.get("content-type"), 
            "contentLength": response.headers.get("content-length") 
        };
    } catch (error) {
        console.log(error.message);
        return null;
    }
}

/**
 * Intercepts the stream before passing it to Google Drive.
 * Uses 'for await' loops to block drive initialization until the uncompressed data layers resolve.
 */
async function processStreamPipeline(inputStream, initialFileName, contentType) {
    const lowerName = initialFileName.toLowerCase();
    const lowerMime = (contentType || '').toLowerCase();

    // --- 1. HANDLE GZIP (.gz) ---
    if (lowerName.endsWith('.gz') || lowerMime === 'application/gzip' || lowerMime === 'application/x-gzip') {
        console.log("Detected GZIP format. Generating decompression piping...");
        const gunzipStream = zlib.createGunzip();
        const decompressedStream = inputStream.pipe(gunzipStream);
        const cleanName = initialFileName.replace(/\.gz\$/i, '');
        
        return { 
            stream: decompressedStream, 
            name: cleanName, 
            mimeType: 'application/octet-stream' 
        };
    }

    // --- 2. HANDLE ZIP (.zip) ---
    if (lowerName.endsWith('.zip') || lowerMime === 'application/zip' || lowerMime === 'application/x-zip-compressed') {
        console.log("Detected ZIP format. Intercepting inner entries...");
        
        // Force the stream parser to yield chunk entities cleanly via standard node runtime iterators
        const zipParser = inputStream.pipe(unzipper.Parse({ forceStream: true }));
        const targetPassThrough = new PassThrough();

        // We run an async lookup loop to catch the first available file stream *before* returning to the drive execution code
        for await (const entry of zipParser) {
            if (entry.type === 'file') {
                console.log(`Extracting file on-the-fly: ${entry.path}`);
                
                // Immediately pipe the entry bytes into the passthrough gate
                entry.pipe(targetPassThrough);

                // Return this structure immediately. Google Drive will read from targetPassThrough
                return {
                    stream: targetPassThrough,
                    name: entry.path,
                    mimeType: 'application/octet-stream'
                };
            } else {
                entry.autodrain(); // Skip folders/metadata instantly without memory allocation
            }
        }
        throw new Error("ZIP file parsing completed but no extractable files were discovered.");
    }

    // --- 3. STANDARD UNCOMPRESSED PASSTHROUGH ---
    return { 
        stream: inputStream, 
        name: initialFileName, 
        mimeType: contentType || 'application/octet-stream' 
    };
}

async function uploadUrlToDrive(url, customHeaders) {
    try {
        const fileInfo = await getFileInfo(url, customHeaders);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        let fileName = Date().toString() + " --- URL_FILE";
        const fetchResponse = await fetch(url, { headers: { "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        if (!fetchResponse.ok) throw new Error(`Failed to download file: ${fetchResponse.status}`);

        const nodeStream = Readable.fromWeb(fetchResponse.body);
        
        // This halts until the true extraction stream structure resolves
        const pipeline = await processStreamPipeline(nodeStream, fileName, fileInfo.contentType);

        console.log(`Streaming extracted asset [${pipeline.name}] directly to Google Drive...`);
        const driveResponse = await drive.files.create({
            requestBody: { name: pipeline.name, parents: [parentFolderId] },
            media: { mimeType: pipeline.mimeType, body: pipeline.stream },
            fields: 'id, name, webViewLink',
        });

        console.log(`Upload complete! Drive Link: ${driveResponse.data.webViewLink}`);
        return driveResponse.data;
    } catch (error) {
        console.error('Error in upload process:', error.message);
        throw error;
    }
}

async function uploadUrlToDriveDirect(url) {
    try {
        const fileInfo = await getFileInfo(url);
        let fileName = Date().toString() + " --- URL_FILE";

        console.log(`Starting direct HTTP/2 stream via curl for: ${fileName}`);
        const curl = spawn('curl', [
            '-s', '-L', '--http2',
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
            url
        ]);

        curl.on('close', (code) => {
            if (code !== 0) console.error(`curl exited with code ${code}`);
        });

        const pipeline = await processStreamPipeline(curl.stdout, fileName, fileInfo ? fileInfo.contentType : '');

        console.log(`Piping extracted asset [${pipeline.name}] directly to Google Drive...`);
        const driveResponse = await drive.files.create({
            requestBody: { name: pipeline.name, parents: [parentFolderId] },
            media: { mimeType: pipeline.mimeType, body: pipeline.stream },
            fields: 'id, name, webViewLink',
        });

        console.log(`Upload complete! Drive Link: ${driveResponse.data.webViewLink}`);
        return driveResponse.data;
    } catch (error) {
        console.error('Error in upload process:', error.message);
        throw error;
    }
}

const runJobLinkWise = async ({ data, id, customHeaders }) => {
    try {
        firebase_utils.updateLink(id, { "status": "Started" });

        const fileInfo = await getFileInfo(data.url, customHeaders);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        let fileName = data.filename || (Date().toString() + " --- URL_FILE");
        firebase_utils.updateLink(id, { "status": "Starting download" });

        const fetchResponse = await fetch(data.url, { headers: { "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        if (!fetchResponse.ok) throw new Error(`Failed to download file: ${fetchResponse.status}`);

        const nodeStream = Readable.fromWeb(fetchResponse.body);
        
        // Await extraction setup processing
        const pipeline = await processStreamPipeline(nodeStream, fileName, fileInfo.contentType);

        firebase_utils.updateLink(id, { "status": `Uploading decompressed file: ${pipeline.name}` });

        const driveResponse = await drive.files.create({
            requestBody: { name: pipeline.name, parents: [parentFolderId] },
            media: { mimeType: pipeline.mimeType, body: pipeline.stream },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true
        });

        firebase_utils.updateLink(id, { "status": "Upload Complete", "completed": true });
    } catch (error) {
        console.error(error);
        firebase_utils.updateLink(id, { "completed": false, "status": error.message });
    }
};

const run_job = async () => {
    const allPendingLinks = await firebase_utils.listPending();
    for (const links of allPendingLinks) {
        await runJobLinkWise(links);
    }
};

run_job();
