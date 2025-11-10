import { getFirestore } from '../firebase';
import { ApiError } from '../errors';
import { GoalRecord, GoalStatus } from '../types/models';

const COLLECTION = 'Goal';

function mapGoal(doc: FirebaseFirestore.DocumentSnapshot): GoalRecord {
    const data = doc.data();
    if (!data) {
        throw new ApiError(500, 'Malformed goal record.');
    }
    return {
        id: doc.id,
        userId: data.userId as string,
        title: (data.title as string | undefined) ?? '',
        description: (data.description as string | null | undefined) ?? null,
        status: (data.status as GoalStatus | undefined) ?? 'active',
        color: (data.color as number | null | undefined) ?? null,
        hoursPerWeek: (data.hoursPerWeek as number | undefined) ?? 0,
        priority: (data.priority as number | undefined) ?? 0,
        milestones: Array.isArray(data.milestones)
            ? (data.milestones as string[])
            : [],
        createdAt: (data.createdAt as string | undefined) ?? new Date().toISOString(),
        updatedAt: (data.updatedAt as string | undefined) ?? new Date().toISOString(),
    };
}

export async function getGoalById(goalId: string): Promise<GoalRecord | null> {
    const db = getFirestore();
    const doc = await db.collection(COLLECTION).doc(goalId).get();
    if (!doc.exists) {
        return null;
    }
    return mapGoal(doc);
}

export interface CreateGoalInput {
    userId: string;
    title: string;
    description?: string | null;
    hoursPerWeek: number;
    priority: number;
    color?: number | null;
    milestones?: string[];
}

export async function createGoal(input: CreateGoalInput): Promise<GoalRecord> {
    const now = new Date().toISOString();
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc();
    const record = {
        userId: input.userId,
        title: input.title,
        description: input.description ?? null,
        status: 'active' as GoalStatus,
        hoursPerWeek: input.hoursPerWeek,
        priority: input.priority,
        color: input.color ?? null,
        milestones: Array.isArray(input.milestones) ? input.milestones : [],
        createdAt: now,
        updatedAt: now,
    };
    await docRef.set({ ...record, id: docRef.id });
    return { id: docRef.id, ...record };
}

export interface ListGoalsOptions {
    userId: string;
    status?: GoalStatus | 'all';
}

export async function listGoals(options: ListGoalsOptions): Promise<GoalRecord[]> {
    const db = getFirestore();
    let query: FirebaseFirestore.Query = db.collection(COLLECTION).where('userId', '==', options.userId);
    if (options.status && options.status !== 'all') {
        query = query.where('status', '==', options.status);
    }
    const snapshot = await query.get();
    return snapshot.docs.map(mapGoal).sort((a, b) => a.priority - b.priority);
}

export interface UpdateGoalInput {
    title?: string;
    description?: string | null;
    status?: GoalStatus;
    hoursPerWeek?: number;
    priority?: number;
    color?: number | null;
    milestones?: string[];
}

export async function updateGoal(goalId: string, updates: UpdateGoalInput): Promise<GoalRecord> {
    const db = getFirestore();
    const docRef = db.collection(COLLECTION).doc(goalId);
    const doc = await docRef.get();
    if (!doc.exists) {
        throw new ApiError(404, 'Goal not found.');
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
    if (updates.hoursPerWeek !== undefined) {
        payload.hoursPerWeek = updates.hoursPerWeek;
    }
    if (updates.priority !== undefined) {
        payload.priority = updates.priority;
    }
    if (updates.color !== undefined) {
        payload.color = updates.color;
    }
    if (updates.milestones !== undefined) {
        payload.milestones = updates.milestones;
    }
    await docRef.update(payload);
    return mapGoal(await docRef.get());
}

export async function sumActiveGoalHours(userId: string, excludeGoalId?: string): Promise<number> {
    const db = getFirestore();
    let query: FirebaseFirestore.Query = db
        .collection(COLLECTION)
        .where('userId', '==', userId)
        .where('status', '==', 'active');
    const snapshot = await query.get();
    return snapshot.docs
        .filter((doc) => doc.id !== excludeGoalId)
        .reduce((total, doc) => {
            const data = doc.data();
            const hours = (data.hoursPerWeek as number | undefined) ?? 0;
            return total + hours;
        }, 0);
}
