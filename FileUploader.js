const { google } = require("googleapis")
const { Readable } = require("stream")
const { spawn } = require('child_process');

const dotenv = require("dotenv")
dotenv.config()

const firebase_utils = require("./firebase/utils")

const authClient = new google.auth.OAuth2({
    client_id: process.env.client_id,
    client_secret: process.env.client_secret
})

authClient.setCredentials({
    refresh_token: process.env.refresh_token
})

const drive = google.drive({ version: 'v3', auth: authClient });
const parentFolderId = process.env.parentFolderId

async function getFileInfo(_url, customHeaders) {
    try {
        const response = await fetch(_url, { method: "HEAD", headers: { "Referer": "https://mzfi.me", ...customHeaders } })
        if (response.status === 426) {
            const requiredProtocol = response.headers.get("upgrade");
            console.error(`\n[BLOCKED] 426 Upgrade Required.`);
            console.error(`The server is demanding: ${requiredProtocol}\n`);
            return null;
        }
        return { "contentType": response.headers.get("content-type"), "contentLength": response.headers.get("content-length") }
    } catch (error) {
        console.log(error.message)
    }
}

async function uploadUrlToDrive(url, customHeaders) {
    try {
        // 1. Get the file info using your utility function
        const fileInfo = await getFileInfo(url,customHeaders);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        const fileName = Date().toString() + " --- URL_FILE"
        console.log(`Starting download for: ${fileName} (${fileInfo.contentType})`);

        // 3. Initiate the actual file download
        const fetchResponse = await fetch(url, { headers: { "Referer": "https://mzfi.me", "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        if (response.status === 426) {
            const requiredProtocol = response.headers.get("upgrade");
            console.error(`\n[BLOCKED] 426 Upgrade Required.`);
            console.error(`The server is demanding: ${requiredProtocol}\n`);
            return null;
        }
        if (!fetchResponse.ok) {
            throw new Error(`Failed to download file: ${fetchResponse.status}`);
        }

        // 4. Convert Web Stream to Node.js Stream
        const nodeStream = Readable.fromWeb(fetchResponse.body);

        console.log(`Streaming ${fileName} directly to Google Drive...`);

        // 5. Pipe to Google Drive
        const driveResponse = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [parentFolderId]
            },
            media: {
                mimeType: fileInfo.contentType,
                body: nodeStream,
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
        // 1. Get file info for the mimeType
        const fileInfo = await getFileInfo(url);

        // 2. Extract filename
        const fileName = Date().toString() + " --- URL_FILE"

        console.log(`Starting direct HTTP/2 stream for: ${fileName}`);

        // 3. Spawn the curl process
        const curl = spawn('curl', [
            '-s',       // Silent mode
            '-L',       // Follow redirects
            '--http2',  // Explicitly use HTTP/2 to avoid 426 errors
            '-H', 'Referer: https://mzfi.me',
            '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
            url
        ]);

        // Optional: Log if curl crashes abruptly
        curl.on('close', (code) => {
            if (code !== 0) console.error(`curl exited with code ${code}`);
        });

        console.log(`Piping directly to Google Drive...`);

        // 4. Pass curl.stdout straight into the Drive request body
        const driveResponse = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [parentFolderId]
            },
            media: {
                mimeType: fileInfo ? fileInfo.contentType : 'application/octet-stream',
                body: curl.stdout, // <-- The direct pipe
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

const runJobLinkWise = async({ data, id, customHeaders }) => {
    try {
        firebase_utils.updateLink(id,{"status":"Started"})

        // 1. Get the file info using your utility function
        const fileInfo = await getFileInfo(data.url,customHeaders);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        const fileName = data.filename || (Date().toString() + " --- URL_FILE")
        firebase_utils.updateLink(id,{"status":"Starting download"})

        // 3. Initiate the actual file download
        const fetchResponse = await fetch(data.url, { headers: { "Referer": "https://mzfi.me", "User-Agent": "PostmanRuntime/7.51.1", ...customHeaders } });
        
        if (!fetchResponse.ok) {
            throw new Error(`Failed to download file: ${fetchResponse.status}`);
        }

        // 4. Convert Web Stream to Node.js Stream
        const nodeStream = Readable.fromWeb(fetchResponse.body);
        firebase_utils.updateLink(id,{"status":"Uploading to Drive..."})

        // 5. Pipe to Google Drive
        const driveResponse = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [parentFolderId]
            },
            media: {
                mimeType: fileInfo.contentType,
                body: nodeStream,
            },
            fields: 'id, name, webViewLink',
            supportsAllDrives: true
        });

        firebase_utils.updateLink(id,{"status":"Upload Complete","completed":true})

    } catch (error) {
        console.error(error)
        firebase_utils.updateLink(id, { "completed": false, "status": error.message })
    }
}

const run_job = async () => {
    const allPendingLinks = await firebase_utils.listPending()
    for (const links of allPendingLinks) {
        runJobLinkWise(links)
    }
}

run_job()
// firebase_utils.addLink()