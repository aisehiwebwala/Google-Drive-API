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
        const json_data = {
            "data": {
                "url": "https://cloud-dl.tvboz6tf9b.workers.dev/ed52b9e5426ea609302fda514fd666ac441e39e782423d4d89bc8de33c567bf5f8599e8abccf6b3203973c78b94f3e0860dfc541f70358ec0f97a00493cc8c5b09e994e8668128b07b2fb973cd0803865a03b1459f442633f6f0662d412f4e049da551d691d94b94e0129d94e76f871fbee9197b51e0c312dc76df046705446777f9003d99db31410ea0824369bd8214ca8fc7b3ae1ce6d0cf8f0c3985c1bdcb96dfb33667ef1bb73776fb9f1a3841c0::aa626b3737bbc377882ce07d9d525878/The%20Dark%20Knight%20(2008)%20IMAX%20%7BHindi-English%7D%201080p%20BluRay%20ESub%20[BollyFlix].mkv?bytes=3296134290",
                "filename": "The Dark Knight (2008)",
            },
            "completed": false,
            "status": "Not Started",
            "createdAt": new Date().toString(),
            "updatedAt": new Date().toString(),
            "customHeaders": {}
        }
        await urls_collection.add(json_data)
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

module.exports = { listAll, addLink, listPending, updateLink, deleteByID, deleteAllCompleted }

