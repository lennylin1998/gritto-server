"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFirestore = getFirestore;
const firebase_admin_1 = __importDefault(require("firebase-admin"));
let firestore;
/**
 * Initializes the Firebase Admin SDK using Application Default Credentials
 */
function getFirestore() {
    if (firestore) {
        return firestore;
    }
    if (!firebase_admin_1.default.apps.length) {
        firebase_admin_1.default.initializeApp();
    }
    firestore = firebase_admin_1.default.firestore();
    firestore.settings({ databaseId: 'gritto-db' });
    return firestore;
}
