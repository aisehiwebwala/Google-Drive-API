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
 * Intercepts the download stream. If it's a ZIP/GZIP, it safely sets up 
 * an internal transform pipe and extracts the inner files on the fly.
 */
async function processStreamPipeline(inputStream, initialFileName, contentType) {
    const lowerName = initialFileName.toLowerCase();
    const lowerMime = (contentType || '').toLowerCase();

    // --- 1. HANDLE GZIP (.gz) ---
    if (lowerName.endsWith('.gz') || lowerMime === 'application/gzip' || lowerMime === 'application/x-gzip') {
        console.log("Detected GZIP file. Decompressing stream on-the-fly...");
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
        console.log("Detected ZIP file. Setting up extraction parser pipeline...");
        
        const zipParseStream = inputStream.pipe(unzipper.Parse());
        const targetPassThrough = new PassThrough();

        // We wrap entry detection in a promise to prevent Google Drive from grabbing the root zip stream prematurely
        const streamReady = new Promise((resolve, reject) => {
            let fileFound = false;

            zipParseStream.on('entry', (entry) => {
                if (entry.type === 'file' && !fileFound) {
                    fileFound = true;
                    console.log(`Extracting file on-the-fly: ${entry.path}`);
                    
                    // Route the extracted payload directly out through our PassThrough gate
                    entry.pipe(targetPassThrough);
                    
                    // Instantly resolve the metadata for Google Drive creation
                    resolve({
                        stream: targetPassThrough,
                        name: entry.path,
                        mimeType: 'application/octet-stream'
                    });
                } else {
                    entry.autodrain(); // Keep moving without RAM overhead
                }
            });

            zipParseStream.on('error', (err) => reject(err));
            zipParseStream.on('end', () => {
                if (!fileFound) reject(new Error("ZIP archive was empty or contained no extraction-friendly files."));
            });
        });

        return await streamReady;
    }

    // --- 3. UNCOMPRESSED PASSTHROUGH ---
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
        console.log(`Starting download stream for: ${fileName}`);

        const fetchResponse = await fetch(url, { headers: { "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        if (!fetchResponse.ok) throw new Error(`Failed to download file: ${fetchResponse.status}`);

        const nodeStream = Readable.fromWeb(fetchResponse.body);
        
        // Asynchronously intercept and restructure the stream pipeline if compressed
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
        
        // Wait for zip parser entry registration
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
