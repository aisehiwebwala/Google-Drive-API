const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore")

// Guard against a second init. Calling initializeApp() twice throws "The default
// Firebase app already exists", which on a serverless platform surfaces as an
// opaque cold-start crash - a bundler that ends up with two copies of this
// module, or a warm instance re-evaluating it, is enough to trigger it.
if (getApps().length === 0) {
    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
    })
}

const db = getFirestore()
module.exports = db