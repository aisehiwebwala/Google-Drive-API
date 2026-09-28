const db = require("./config")

const urls_collection = db.collection(process.env.URL_COLLECTION_NAME)

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

const addLink = async () => {
    try {
        const data = {
            "url": "https://assets.mixkit.co/videos/41576/41576-720.mp4",
            "completed": false,
            "status": "Not Started",
            "createdAt": new Date().toString(),
            "updatedAt": new Date().toString(),
            "customHeaders": {}
        }
        await urls_collection.add(data)
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

module.exports = { listAll, addLink, listPending, updateLink, deleteByID, deleteAllCompleted}

