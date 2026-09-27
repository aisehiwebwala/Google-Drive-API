const { google } = require("googleapis")
const { Readable } = require("stream")

const dotenv = require("dotenv")
dotenv.config()

// const serviceJson = require("./service2.json")

const authClient = new google.auth.OAuth2({
    client_id: process.env.client_id,
    client_secret: process.env.client_secret
})

authClient.setCredentials({
    refresh_token: process.env.refresh_token
})

const drive = google.drive({ version: 'v3', auth: authClient });

async function getFileInfo(_url) {
    try {
        const response = await fetch(_url, { method: "HEAD", headers: { "Referer": _url } })
        return { "contentType": response.headers.get("content-type"), "contentLength": response.headers.get("content-length") }
    } catch (error) {
        console.log(error.message)
    }
}

async function uploadUrlToDrive(url, parentFolderId) {
    try {
        // 1. Get the file info using your utility function
        const fileInfo = await getFileInfo(url);
        if (!fileInfo) throw new Error("Could not retrieve file information.");

        const fileName = Date().toString() + " --- URL_FILE"
        console.log(`Starting download for: ${fileName} (${fileInfo.contentType})`);

        // 3. Initiate the actual file download
        const fetchResponse = await fetch(url, { headers: { "Referer": url } });
        if (!fetchResponse.ok) {
            throw new Error(`Failed to download file: ${fetchResponse.statusText}`);
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

uploadUrlToDrive("https://www.w3schools.com/Html/mov_bbb.mp4", process.env.parentFolderId)