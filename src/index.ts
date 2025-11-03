import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import morgan from 'morgan';

import { getFirestore } from './firebase';

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 8080;

app.use(morgan('dev'));
app.use(express.json());

app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

type FirestoreParams = { collection: string; docId: string };

app.get(
    '/firestore/:collection/:docId',
    async (req: Request<FirestoreParams>, res: Response, next: NextFunction) => {
        try {
            const db = getFirestore();
            const doc = await db.collection(req.params.collection).doc(req.params.docId).get();

            if (!doc.exists) {
                res.status(404).json({ error: 'Document not found.' });
                return;
            }

            res.json({ id: doc.id, data: doc.data() });
        } catch (error) {
            next(error);
        }
    }
);

type FirestoreCollectionParams = { collection: string };
type FirestoreDocument = Record<string, unknown>;

app.post(
    '/firestore/:collection',
    async (
        req: Request<FirestoreCollectionParams, unknown, FirestoreDocument>,
        res: Response,
        next: NextFunction
    ) => {
        try {
            const db = getFirestore();
            const docRef = await db.collection(req.params.collection).add(req.body);
            res.status(201).json({ id: docRef.id });
        } catch (error) {
            next(error);
        }
    }
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Internal server error', details: message });
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
