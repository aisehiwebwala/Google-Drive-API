const db = require("./config")

if (!process.env.URL_COLLECTION_NAME) {
    throw new Error("URL_COLLECTION_NAME is not set")
}

const urls_collection = db.collection(process.env.URL_COLLECTION_NAME)

// createdAt/updatedAt are stored as Date().toString() strings rather than
// Firestore Timestamps, so they cannot be ordered in the query itself.
const byNewestFirst = (a, b) => {
    const left = Date.parse(a.createdAt) || 0
    const right = Date.parse(b.createdAt) || 0
    return right - left
}

const listAll = async () => {
    try {
        const snapshot = await urls_collection.get();

        if (snapshot.empty) {
            return [];
        }

        const allDocs = snapshot.docs.map(doc => ({
            id: doc.id,         // The document ID (e.g., "alovelace")
            ...doc.data()       // The actual fields inside the document
        }));
        return allDocs;

    } catch (error) {
        console.error('Error getting documents: ', error);
        throw error
    }
}

const listPending = async () => {
    try {
        const snapshot = await urls_collection.where("completed", "==", false).get();

        if (snapshot.empty) {
            return [];
        }

        const allDocs = snapshot.docs.map(doc => ({
            id: doc.id,         // The document ID (e.g., "alovelace")
            ...doc.data()       // The actual fields inside the document
        }));
        return allDocs;

    } catch (error) {
        console.error('Error getting documents: ', error);
        throw error
    }
}

// Returns every link, newest first, for the console's status table.
const listLinks = async () => {
    const allDocs = await listAll()
    return allDocs.sort(byNewestFirst)
}

const addLink = async ({ url, filename = "", customHeaders = {} } = {}) => {
    try {
        if (!url) throw new Error("url is required")

        const now = new Date().toString()
        const json_data = {
            "data": {
                "url": url,
                "filename": filename,
            },
            "completed": false,
            "status": "Not Started",
            "createdAt": now,
            "updatedAt": now,
            "customHeaders": customHeaders
        }
        const docRef = await urls_collection.add(json_data)
        return { id: docRef.id, ...json_data }
    } catch (error) {
        console.error('Error adding document: ', error);
        throw error
    }
}

const updateLink = async (_id, newData) => {
    try {
        // 1. Reference the specific document using its ID
        const docRef = urls_collection.doc(_id);

        // 2. Perform the update
        await docRef.update({ ...newData, "updatedAt": new Date().toString() });
        return { success: true };

    } catch (error) {
        // If the document ID doesn't exist, Firestore will throw an error
        console.error('Error updating document: ', error);
        return { success: false, error: error.message };
    }
}

const deleteByID = async (_id) => {
    try {
        // 1. Reference the specific document using its ID
        const docRef = urls_collection.doc(_id);

        // 2. Perform the deletion
        await docRef.delete();

        return { success: true };

    } catch (error) {
        console.error('Error deleting document: ', error);
        return { success: false, error: error.message };
    }
}

const deleteAllCompleted = async () => {
    try {
        // 1. Get all documents matching the condition
        const snapshot = await urls_collection.where('completed', '==', true).get();

        if (snapshot.empty) {
            return { deletedCount: 0 };
        }

        // 2. Initialize a Write Batch
        const batch = db.batch();

        // 3. Loop through results and add each delete operation to the batch
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });

        // 4. Commit all deletions at once
        await batch.commit();
        return { success: true, deletedCount: snapshot.size };

    } catch (error) {
        console.error('Error during batch deletion: ', error);
        return { success: false, error: error.message };
    }
}

module.exports = { listAll, listLinks, addLink, listPending, updateLink, deleteByID, deleteAllCompleted }

