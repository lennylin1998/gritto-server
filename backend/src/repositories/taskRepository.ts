import { getFirestore } from '../firebase';
import { ApiError } from '../errors';
import { TaskRecord } from '../types/models';

const COLLECTION = 'Task';

function mapTask(doc: FirebaseFirestore.DocumentSnapshot): TaskRecord {
    const data = doc.data();
    if (!data) {
        throw new ApiError(500, 'Malformed task record.');
    }
    return {
        id: doc.id,
        goalId: data.goalId as string,
        milestoneId: data.milestoneId as string,
        userId: data.userId as string,
        title: (data.title as string | undefined) ?? '',
        description: (data.description as string | null | undefined) ?? null,
        date: (data.date as string | undefined) ?? new Date().toISOString(),
        estimatedHours: (data.estimatedHours as number | undefined) ?? 0,
        done: Boolean(data.done),
        createdAt: (data.createdAt as string | undefined) ?? new Date().toISOString(),
        updatedAt: (data.updatedAt as string | undefined) ?? new Date().toISOString(),
    };
}

export interface CreateTaskInput {
    goalId: string;
    milestoneId: string;
    userId: string;
    title: string;
    description?: string | null;
    date: string;
    estimatedHours: number;
}

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc();
    const record = {
        goalId: input.goalId,
        milestoneId: input.milestoneId,
        userId: input.userId,
        title: input.title,
        description: input.description ?? null,
        date: input.date,
        estimatedHours: input.estimatedHours,
        done: false,
        createdAt: now,
        updatedAt: now,
    };
    await docRef.set({ ...record, id: docRef.id });
    return { id: docRef.id, ...record };
}

export async function getTaskById(id: string): Promise<TaskRecord | null> {
    const db = getFirestore();
    const doc = await db.collection(COLLECTION).doc(id).get();
    if (!doc.exists) {
        return null;
    }
    return mapTask(doc);
}

export interface UpdateTaskInput {
    title?: string;
    description?: string | null;
    date?: string;
    estimatedHours?: number;
    done?: boolean;
}

export async function updateTask(id: string, updates: UpdateTaskInput): Promise<TaskRecord> {
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
        throw new ApiError(404, 'Task not found.');
    }
    const payload: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (updates.title !== undefined) {
        payload.title = updates.title;
    }
    if (updates.description !== undefined) {
        payload.description = updates.description;
    }
    if (updates.date !== undefined) {
        payload.date = updates.date;
    }
    if (updates.estimatedHours !== undefined) {
        payload.estimatedHours = updates.estimatedHours;
    }
    if (updates.done !== undefined) {
        payload.done = updates.done;
    }
    await docRef.update(payload);
    return mapTask(await docRef.get());
}

export async function setTaskDone(id: string, done: boolean): Promise<TaskRecord> {
    return updateTask(id, { done });
}

export async function listTasksByMilestone(milestoneId: string): Promise<TaskRecord[]> {
    const db = getFirestore();
    const snapshot = await db.collection(COLLECTION).where('milestoneId', '==', milestoneId).get();
    return snapshot.docs.map(mapTask);
}

export async function listTasksByDateRange(
    userId: string,
    startDate: string,
    endDate: string
): Promise<TaskRecord[]> {
    const db = getFirestore();
    const snapshot = await db
        .collection(COLLECTION)
        .where('userId', '==', userId)
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .get();
    return snapshot.docs.map(mapTask);
}

export async function listTasksByGoal(goalId: string): Promise<TaskRecord[]> {
    const db = getFirestore();
    const snapshot = await db.collection(COLLECTION).where('goalId', '==', goalId).get();
    return snapshot.docs.map(mapTask);
}

export async function listIncompleteTasksByUser(userId: string): Promise<TaskRecord[]> {
    const db = getFirestore();
    const snapshot = await db
        .collection(COLLECTION)
        .where('userId', '==', userId)
        .where('done', '==', false)
        .get();
    return snapshot.docs.map(mapTask).sort((a, b) => a.date.localeCompare(b.date));
}
