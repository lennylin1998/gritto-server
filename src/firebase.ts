import admin from 'firebase-admin';

let firestore: FirebaseFirestore.Firestore | undefined;

/**
 * Initializes the Firebase Admin SDK using Application Default Credentials
 */
export function getFirestore(): FirebaseFirestore.Firestore {
    if (firestore) {
        return firestore;
    }

    if (!admin.apps.length) {
        admin.initializeApp();
    }

    firestore = admin.firestore();
    firestore.settings({ databaseId: 'gritto-db' });
    return firestore;
}