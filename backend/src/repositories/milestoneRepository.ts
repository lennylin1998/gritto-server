import { getFirestore } from '../firebase';
import { ApiError } from '../errors';
import { MilestoneRecord, MilestoneStatus } from '../types/models';

const COLLECTION = 'Milestone';

function mapMilestone(doc: FirebaseFirestore.DocumentSnapshot): MilestoneRecord {
    const data = doc.data();
    if (!data) {
        throw new ApiError(500, 'Malformed milestone record.');
    }
    return {
        id: doc.id,
        goalId: data.goalId as string,
        parentMilestoneId: (data.parentMilestoneId as string | null | undefined) ?? null,
        title: (data.title as string | undefined) ?? '',
        description: (data.description as string | null | undefined) ?? null,
        status: (data.status as MilestoneStatus | undefined) ?? 'blocked',
        tasks: Array.isArray(data.tasks) ? (data.tasks as string[]) : [],
        createdAt: (data.createdAt as string | undefined) ?? new Date().toISOString(),
        updatedAt: (data.updatedAt as string | undefined) ?? new Date().toISOString(),
    };
}

export async function listMilestonesByGoal(goalId: string): Promise<MilestoneRecord[]> {
    const db = getFirestore();
    const snapshot = await db.collection(COLLECTION).where('goalId', '==', goalId).get();
    return snapshot.docs.map(mapMilestone);
}

export async function getMilestoneById(id: string): Promise<MilestoneRecord | null> {
    const db = getFirestore();
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapMilestone(doc);
}

export interface CreateMilestoneInput {
    goalId: string;
    title: string;
    description?: string | null;
    parentMilestoneId?: string | null;
    tasks?: string[];
}

export async function createMilestone(input: CreateMilestoneInput): Promise<MilestoneRecord> {
    const now = new Date().toISOString();
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc();
    const record = {
        goalId: input.goalId,
        title: input.title,
        description: input.description ?? null,
        status: 'blocked' as MilestoneStatus,
        parentMilestoneId: input.parentMilestoneId ?? null,
        tasks: Array.isArray(input.tasks) ? input.tasks : [],
        createdAt: now,
        updatedAt: now,
    };
    await docRef.set({ ...record, id: docRef.id });
    return { id: docRef.id, ...record };
}

export interface UpdateMilestoneInput {
    title?: string;
    description?: string | null;
    status?: MilestoneStatus;
    tasks?: string[];
}

export async function updateMilestone(id: string, updates: UpdateMilestoneInput): Promise<MilestoneRecord> {
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
        throw new ApiError(404, 'Milestone not found.');
    }
    const payload: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (updates.title !== undefined) {
        payload.title = updates.title;
    }
    if (updates.description !== undefined) {
        payload.description = updates.description;
    }
    if (updates.status !== undefined) {
        payload.status = updates.status;
    }
    if (updates.tasks !== undefined) {
        payload.tasks = updates.tasks;
    }
    await docRef.update(payload);
    return mapMilestone(await docRef.get());
}
