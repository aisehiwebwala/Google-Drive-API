const { google } = require("googleapis");
const { Readable } = require("stream");
const { spawn } = require('child_process');
const zlib = require('zlib'); // Built-in for .gz / deflate
const unzipper = require('unzipper'); // For streaming .zip archives

const dotenv = require("dotenv");
dotenv.config();

const firebase_utils = require("./firebase/utils");

const authClient = new google.auth.OAuth2({
    client_id: process.env.client_id,
    client_secret: process.env.client_secret
});

authClient.setCredentials({
    refresh_token: process.env.refresh_token
});

const drive = google.drive({ version: 'v3', auth: authClient });
const parentFolderId = process.env.parentFolderId;

async function getFileInfo(_url, customHeaders) {
    try {
        const response = await fetch(_url, { method: "HEAD", headers: { ...customHeaders } });
        if (response.status === 426) {
            const requiredProtocol = response.headers.get("upgrade");
            console.error(`\n[BLOCKED] 426 Upgrade Required.`);
            console.error(`The server is demanding: ${requiredProtocol}\n`);
            return null;
        }
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
 * Checks content-type or filename to handle decompressions on-the-fly.
 * Returns { stream: Readable, name: string, mimeType: string }
 */
function handleDecompressionPipeline(inputStream, initialFileName, contentType) {
    const lowerName = initialFileName.toLowerCase();
    const lowerMime = (contentType || '').toLowerCase();

    // 1. Handle GZIP (.gz)
    if (lowerName.endsWith('.gz') || lowerMime === 'application/gzip' || lowerMime === 'application/x-gzip') {
        console.log("Detected GZIP file. Decompressing on the fly...");
        const gunzipStream = zlib.createGunzip();
        const decompressedStream = inputStream.pipe(gunzipStream);
        
        // Strip out the .gz extension for Google Drive
        const cleanName = initialFileName.replace(/\.gz$/i, '');
        return { 
            stream: decompressedStream, 
            name: cleanName, 
            mimeType: 'application/octet-stream' 
        };
    }

    // 2. Handle ZIP (.zip)
    if (lowerName.endsWith('.zip') || lowerMime === 'application/zip' || lowerMime === 'application/x-zip-compressed') {
        console.log("Detected ZIP file. Extracting first file on the fly...");
        
        // Transform the stream into a zip parser
        const zipParseStream = inputStream.pipe(unzipper.Parse());
        
        // We create a PassThrough stream that Google Drive can read from instantly
        const targetReadable = new zlib.PassThrough(); 
        let fileDispatched = false;

        zipParseStream.on('entry', (entry) => {
            // Take the first actual file found in the archive
            if (entry.type === 'file' && !fileDispatched) {
                fileDispatched = true;
                console.log(`Extracting: ${entry.path}`);
                
                // Update or inherit the filename from inside the zip
                targetReadable.filename = entry.path; 
                entry.pipe(targetReadable);
            } else {
                entry.autodrain(); // Skip other files or directories safely without RAM leaks
            }
        });

        zipParseStream.on('error', (err) => targetReadable.emit('error', err));

        return { 
            stream: targetReadable, 
            name: initialFileName, // Will fallback to this unless overridden down the line
            mimeType: 'application/octet-stream',
            isZip: true
        };
    }

    // 3. Uncompressed file - Pass through untouched
    return { stream: inputStream, name: initialFileName, mimeType: contentType || 'application/octet-stream' };
}

async function uploadUrlToDrive(url, customHeaders) {
    try {
        const fileInfo = await getFileInfo(url, customHeaders);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        let fileName = Date().toString() + " --- URL_FILE";
        console.log(`Starting download for: ${fileName} (${fileInfo.contentType})`);

        const fetchResponse = await fetch(url, { headers: { "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        if (fetchResponse.status === 426) {
            throw new Error("426 Upgrade Required");
        }
        if (!fetchResponse.ok) {
            throw new Error(`Failed to download file: ${fetchResponse.status}`);
        }

        const nodeStream = Readable.fromWeb(fetchResponse.body);
        
        // Process pipeline for decompression
        let pipeline = handleDecompressionPipeline(nodeStream, fileName, fileInfo.contentType);

        // If it was a zip file, wait briefly for the 'entry' event to parse the filename inside the zip
        if (pipeline.isZip) {
            await new Promise((resolve) => {
                pipeline.stream.once('data', () => {
                    if (pipeline.stream.filename) pipeline.name = pipeline.stream.filename;
                    resolve();
                });
                // Safety timeout if zip is empty or invalid
                setTimeout(resolve, 1500);
            });
        }

        console.log(`Streaming ${pipeline.name} directly to Google Drive...`);

        const driveResponse = await drive.files.create({
            requestBody: {
                name: pipeline.name,
                parents: [parentFolderId]
            },
            media: {
                mimeType: pipeline.mimeType,
                body: pipeline.stream,
            },
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

        console.log(`Starting direct HTTP/2 stream for: ${fileName}`);

        const curl = spawn('curl', [
            '-s', '-L', '--http2',
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
            url
        ]);

        curl.on('close', (code) => {
            if (code !== 0) console.error(`curl exited with code ${code}`);
        });

        // Process pipeline for decompression from curl stdout
        let pipeline = handleDecompressionPipeline(curl.stdout, fileName, fileInfo ? fileInfo.contentType : '');

        if (pipeline.isZip) {
            await new Promise((resolve) => {
                pipeline.stream.once('data', () => {
                    if (pipeline.stream.filename) pipeline.name = pipeline.stream.filename;
                    resolve();
                });
                setTimeout(resolve, 1500);
            });
        }

        console.log(`Piping directly to Google Drive...`);

        const driveResponse = await drive.files.create({
            requestBody: {
                name: pipeline.name,
                parents: [parentFolderId]
            },
            media: {
                mimeType: pipeline.mimeType,
                body: pipeline.stream,
            },
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
        if (!fetchResponse.ok) {
            throw new Error(`Failed to download file: ${fetchResponse.status}`);
        }

        const nodeStream = Readable.fromWeb(fetchResponse.body);
        
        // Process pipeline for decompression
        let pipeline = handleDecompressionPipeline(nodeStream, fileName, fileInfo.contentType);

        if (pipeline.isZip) {
            await new Promise((resolve) => {
                pipeline.stream.once('data', () => {
                    if (pipeline.stream.filename) pipeline.name = pipeline.stream.filename;
                    resolve();
                });
                setTimeout(resolve, 1500);
            });
        }

        firebase_utils.updateLink(id, { "status": "Uploading to Drive..." });

        const driveResponse = await drive.files.create({
            requestBody: {
                name: pipeline.name,
                parents: [parentFolderId]
            },
            media: {
                mimeType: pipeline.mimeType,
                body: pipeline.stream,
            },
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
