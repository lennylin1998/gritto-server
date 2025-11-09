import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import morgan from 'morgan';

import { ApiError, assert } from './errors';
import { authMiddleware } from './middleware/auth';
import { verifyGoogleIdToken } from './services/googleAuthService';
import { signJwt } from './services/tokenService';
import {
    createUser,
    findUserByEmail,
    findUserById,
    updateUser,
} from './repositories/userRepository';
import {
    createGoal,
    getGoalById,
    listGoals,
    sumActiveGoalHours,
    updateGoal,
} from './repositories/goalRepository';
import {
    createMilestone,
    getMilestoneById,
    listMilestonesByGoal,
    updateMilestone,
} from './repositories/milestoneRepository';
import {
    createTask,
    getTaskById,
    listTasksByDateRange,
    listTasksByGoal,
    listTasksByMilestone,
    setTaskDone,
    updateTask,
} from './repositories/taskRepository';
import {
    appendChatMessage,
    createSession,
    findLatestActiveSession,
    findSessionById,
    updateSession,
} from './repositories/sessionRepository';
import { findGoalPreviewById, GoalPreviewRecord, upsertGoalPreview } from './repositories/goalPreviewRepository';
import { buildUserContext } from './services/contextService';
import { buildAgentInvocationPayload, initRemoteSession, invokeAgentService } from './services/agentService';
import type {
    GoalRecord,
    GoalStatus,
    MilestoneRecord,
    MilestoneStatus,
    SessionStateRecord,
    TaskRecord,
    UserRecord,
} from './types/models';

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 8080;

const GOAL_STATUSES: GoalStatus[] = ['active', 'completed', 'paused', 'archived'];
const MILESTONE_STATUSES: MilestoneStatus[] = ['blocked', 'in_progress', 'finished'];
const MAX_AVAILABLE_HOURS = 168;

app.use(morgan('dev'));
app.use(express.json());

function serializeUser(user: UserRecord) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        profileImageUrl: user.profileImageUrl,
        timezone: user.timezone,
        availableHoursPerWeek: user.availableHoursPerWeek,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

function serializeGoal(goal: GoalRecord) {
    return {
        id: goal.id,
        userId: goal.userId,
        title: goal.title,
        description: goal.description ?? null,
        status: goal.status,
        color: goal.color ?? null,
        minHoursPerWeek: goal.minHoursPerWeek,
        priority: goal.priority,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
    };
}

function serializeMilestone(milestone: MilestoneRecord) {
    return {
        id: milestone.id,
        goalId: milestone.goalId,
        parentMilestoneId: milestone.parentMilestoneId ?? null,
        title: milestone.title,
        description: milestone.description ?? null,
        status: milestone.status,
        createdAt: milestone.createdAt,
        updatedAt: milestone.updatedAt,
    };
}

function serializeTask(task: TaskRecord) {
    return {
        id: task.id,
        goalId: task.goalId,
        milestoneId: task.milestoneId,
        title: task.title,
        description: task.description ?? null,
        date: task.date,
        estimatedHours: task.estimatedHours,
        done: task.done,
        status: task.done ? 'done' : 'not_yet_done',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function summarizeTaskHours(tasks: TaskRecord[]): { totalTaskHours: number; doneTaskHours: number } {
    return tasks.reduce(
        (accumulator, task) => {
            const hours = Number(task.estimatedHours) || 0;
            accumulator.totalTaskHours += hours;
            if (task.done) {
                accumulator.doneTaskHours += hours;
            }
            return accumulator;
        },
        { totalTaskHours: 0, doneTaskHours: 0 }
    );
}

function isValidGoalStatus(value: unknown): value is GoalStatus {
    return typeof value === 'string' && (GOAL_STATUSES as ReadonlyArray<string>).includes(value);
}

function isValidMilestoneStatus(value: unknown): value is MilestoneStatus {
    return typeof value === 'string' && (MILESTONE_STATUSES as ReadonlyArray<string>).includes(value);
}

function isValidDay(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDayRange(day: string): { start: string; end: string } {
    return { start: day, end: day };
}

async function assertOwnedGoal(goalId: string, userId: string): Promise<GoalRecord> {
    const goal = await getGoalById(goalId);
    assert(goal, 404, 'Goal not found.');
    assert(goal.userId === userId, 403, 'Forbidden.');
    return goal;
}

async function assertOwnedMilestone(milestoneId: string, userId: string): Promise<MilestoneRecord> {
    const milestone = await getMilestoneById(milestoneId);
    assert(milestone, 404, 'Milestone not found.');
    await assertOwnedGoal(milestone.goalId, userId);
    return milestone;
}

async function assertOwnedTask(taskId: string, userId: string): Promise<{ task: TaskRecord; milestone: MilestoneRecord }> {
    const task = await getTaskById(taskId);
    assert(task, 404, 'Task not found.');
    const milestone = await assertOwnedMilestone(task.milestoneId, userId);
    return { task, milestone };
}

async function computeGoalMetrics(goalId: string): Promise<{ goalId: string; totalTaskHours: number; doneTaskHours: number }> {
    const tasks = await listTasksByGoal(goalId);
    const metrics = summarizeTaskHours(tasks);
    return { goalId, ...metrics };
}

async function computeMilestoneMetrics(
    milestoneId: string
): Promise<{ milestoneId: string; totalTaskHours: number; doneTaskHours: number }> {
    const tasks = await listTasksByMilestone(milestoneId);
    const metrics = summarizeTaskHours(tasks);
    return { milestoneId, ...metrics };
}

async function collectActiveGoalSummaries(
    userId: string,
    excludeGoalId?: string
): Promise<Array<{ goalId: string; title: string; weeklyHours: number }>> {
    const goals = await listGoals({ userId, status: 'active' });
    return goals
        .filter((goal) => goal.id !== excludeGoalId)
        .map((goal) => ({
            goalId: goal.id,
            title: goal.title,
            weeklyHours: goal.minHoursPerWeek,
        }));
}

async function ensureNoTaskConflict(
    milestoneId: string,
    userId: string,
    date: string,
    excludeTaskId?: string
): Promise<void> {
    const tasks = await listTasksByMilestone(milestoneId);
    const conflicting = tasks.filter(
        (task) => task.id !== excludeTaskId && task.userId === userId && task.date === date
    );
    if (conflicting.length > 0) {
        throw new ApiError(409, 'Task date conflicts with an existing scheduled task or calendar event.', {
            conflictingTaskIds: conflicting.map((task) => task.id),
        });
    }
}

function serializeSession(session: SessionStateRecord) {
    return {
        sessionId: session.id,
        chatId: session.chatId,
        state: session.state,
        iteration: session.iteration,
        goalPreviewId: session.goalPreviewId ?? null,
        context: session.context ?? {},
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
    };
}

function validateEstimatedHours(value: unknown): number {
    assert(typeof value === 'number' && Number.isFinite(value), 400, 'estimatedHours must be a number.');
    assert(value >= 0, 400, 'estimatedHours must be zero or positive.');
    return value;
}

function validateIsoDate(value: unknown): string {
    assert(typeof value === 'string' && value.trim().length > 0, 400, 'date is required.');
    const parsed = new Date(value);
    assert(!Number.isNaN(parsed.valueOf()), 400, 'Invalid date format.');
    return parsed.toISOString().slice(0, 10);
}

type AgentGoalPlan = {
    title?: string;
    description?: string;
    minHoursPerWeek?: number;
    priority?: number;
    color?: number;
};

type AgentTaskPlan = {
    title?: string;
    description?: string;
    date?: string;
    estimatedHours?: number;
    done?: boolean;
};

type AgentMilestonePlan = {
    title?: string;
    description?: string;
    status?: string;
    tasks?: AgentTaskPlan[] | null;
};

type AgentPlanContainer = {
    goal?: AgentGoalPlan;
    milestones?: AgentMilestonePlan[] | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object') {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function readStringField(container: Record<string, unknown> | undefined, field: string): string | undefined {
    if (!container) {
        return undefined;
    }
    const value = container[field];
    return typeof value === 'string' ? value : undefined;
}

function extractPlanContainer(
    payload: Record<string, unknown>,
    preview: GoalPreviewRecord | null
): AgentPlanContainer {
    const payloadWithGoalPreview = (payload as { goalPreview?: unknown }).goalPreview;
    const payloadPlan = (payload as { plan?: unknown }).plan;
    return (
        (asRecord(payloadWithGoalPreview) as AgentPlanContainer | undefined) ??
        (asRecord(payloadPlan) as AgentPlanContainer | undefined) ??
        (preview?.data as AgentPlanContainer | undefined) ??
        (payload as AgentPlanContainer) ??
        {}
    );
}

function computePlanTaskHours(milestones: AgentMilestonePlan[]): number {
    return milestones.reduce((goalTotal, milestone) => {
        const tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
        const taskHours = tasks.reduce((sum, task) => {
            const hours =
                typeof task?.estimatedHours === 'number' && Number.isFinite(task.estimatedHours)
                    ? Math.max(0, task.estimatedHours)
                    : 0;
            return sum + hours;
        }, 0);
        return goalTotal + taskHours;
    }, 0);
}

function coerceIsoDayString(value: unknown): string {
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.valueOf())) {
            return parsed.toISOString().slice(0, 10);
        }
    }
    return new Date().toISOString().slice(0, 10);
}

async function finalizeGoalPlanFromAgentPayload(
    user: UserRecord,
    payload: Record<string, unknown>
): Promise<{ goal: GoalRecord; milestoneIds: string[]; taskIds: string[]; goalPreviewId?: string }> {
    const previewId =
        readStringField(payload, 'goalPreviewId') ??
        readStringField(asRecord((payload as { goalPreview?: unknown }).goalPreview), 'id');
    const previewRecord = previewId ? await findGoalPreviewById(previewId) : null;
    const planContainer = extractPlanContainer(payload, previewRecord);
    const goalPlan = (planContainer.goal as AgentGoalPlan | undefined) ?? {};
    const milestonePlans = Array.isArray(planContainer.milestones)
        ? (planContainer.milestones as AgentMilestonePlan[])
        : [];

    const goalTitle =
        typeof goalPlan.title === 'string' && goalPlan.title.trim().length > 0 ? goalPlan.title.trim() : 'Untitled Goal';
    const description = typeof goalPlan.description === 'string' ? goalPlan.description : null;
    const planHours =
        typeof goalPlan.minHoursPerWeek === 'number' && Number.isFinite(goalPlan.minHoursPerWeek)
            ? Math.max(0, goalPlan.minHoursPerWeek)
            : computePlanTaskHours(milestonePlans);
    const priority =
        typeof goalPlan.priority === 'number' && Number.isFinite(goalPlan.priority)
            ? Math.trunc(goalPlan.priority)
            : 0;
    const color = typeof goalPlan.color === 'number' && Number.isFinite(goalPlan.color) ? goalPlan.color : null;

    const existingActiveHours = await sumActiveGoalHours(user.id);
    const totalRequiredHours = existingActiveHours + planHours;
    if (totalRequiredHours > user.availableHoursPerWeek) {
        const conflicts = await collectActiveGoalSummaries(user.id);
        conflicts.push({ goalId: 'pending', title: goalTitle, weeklyHours: planHours });
        throw new ApiError(
            409,
            `Available hours (${user.availableHoursPerWeek}h/week) are insufficient for current active goals (${totalRequiredHours}h/week with new goal).`,
            {
                availableHoursPerWeek: user.availableHoursPerWeek,
                requiredHoursPerWeek: totalRequiredHours,
                conflictingGoals: conflicts,
            }
        );
    }

    const goal = await createGoal({
        userId: user.id,
        title: goalTitle,
        description,
        minHoursPerWeek: planHours,
        priority,
        color,
    });

    const milestoneIds: string[] = [];
    const taskIds: string[] = [];

    for (const milestonePlan of milestonePlans) {
        const milestoneTitle =
            typeof milestonePlan.title === 'string' && milestonePlan.title.trim().length > 0
                ? milestonePlan.title.trim()
                : 'Milestone';
        const milestoneDescription = typeof milestonePlan.description === 'string' ? milestonePlan.description : null;
        const milestone = await createMilestone({
            goalId: goal.id,
            title: milestoneTitle,
            description: milestoneDescription,
            parentMilestoneId: null,
        });
        milestoneIds.push(milestone.id);

        const milestoneStatus =
            typeof milestonePlan.status === 'string' && isValidMilestoneStatus(milestonePlan.status)
                ? (milestonePlan.status as MilestoneStatus)
                : undefined;
        if (milestoneStatus && milestoneStatus !== milestone.status) {
            await updateMilestone(milestone.id, { status: milestoneStatus });
        }

        const tasks = Array.isArray(milestonePlan.tasks) ? milestonePlan.tasks : [];
        for (const taskPlan of tasks) {
            const taskTitle =
                typeof taskPlan?.title === 'string' && taskPlan.title.trim().length > 0
                    ? taskPlan.title.trim()
                    : 'Task';
            const taskDescription = typeof taskPlan?.description === 'string' ? taskPlan.description : null;
            const estimatedHours =
                typeof taskPlan?.estimatedHours === 'number' && Number.isFinite(taskPlan.estimatedHours)
                    ? Math.max(0, taskPlan.estimatedHours)
                    : 0;
            const date = coerceIsoDayString(taskPlan?.date);
            const createdTask = await createTask({
                goalId: goal.id,
                milestoneId: milestone.id,
                userId: user.id,
                title: taskTitle,
                description: taskDescription,
                date,
                estimatedHours,
            });
            taskIds.push(createdTask.id);
            if (taskPlan?.done) {
                await setTaskDone(createdTask.id, true);
            }
        }
    }

    return { goal, milestoneIds, taskIds, goalPreviewId: previewRecord?.id ?? previewId };
}

function extractPreviewPayload(
    payload: Record<string, unknown> | undefined
): { id?: string; data: Record<string, unknown> } {
    const container = payload ?? {};
    const nested = payload ? asRecord((payload as { goalPreview?: unknown }).goalPreview) : undefined;
    const data = nested ?? container;
    const previewId = readStringField(payload, 'goalPreviewId') ?? readStringField(data, 'id');
    return { id: previewId, data };
}

app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/v1/auth/google', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { idToken } = req.body ?? {};
        assert(typeof idToken === 'string' && idToken.trim().length > 0, 400, 'idToken is required.');
        const profile = await verifyGoogleIdToken(idToken);
        assert(profile.emailVerified, 403, 'Google account email not verified.');
        
        let user = await findUserByEmail(profile.email);
        let statusCode = 200;
        if (!user) {
            const derivedName = profile.name?.trim() ?? profile.email.split('@')[0];
            user = await createUser({
                email: profile.email,
                name: derivedName,
                profileImageUrl: profile.picture ?? null,
                timezone: 'UTC',
                availableHoursPerWeek: 20,
                googleSub: profile.sub,
            });
            statusCode = 201;
        } else {
            const updates: Parameters<typeof updateUser>[1] = { googleSub: profile.sub };
            if (profile.name && profile.name.trim().length > 0) {
                updates.name = profile.name;
            }
            if (profile.picture) {
                updates.profileImageUrl = profile.picture;
            }
            await updateUser(user.id, updates);
            user = (await findUserById(user.id)) as UserRecord;
        }
        
        const token = signJwt({ userId: user.id, email: user.email });
        res.status(statusCode).json({
            data: {
                token,
                user: serializeUser(user),
            },
        });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const user = await findUserById(userId);
        assert(user, 404, 'User not found.');
        res.json({ data: serializeUser(user) });
    } catch (error) {
        next(error);
    }
});

app.patch('/v1/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const user = await findUserById(userId);
        assert(user, 404, 'User not found.');

        const { name, timezone, availableHoursPerWeek, profileImageUrl } = req.body ?? {};
        const updates: Parameters<typeof updateUser>[1] = {};
        let hasUpdate = false;

        if (name !== undefined) {
            assert(typeof name === 'string' && name.trim().length > 0, 400, 'Invalid name.');
            updates.name = name;
            hasUpdate = true;
        }
        if (timezone !== undefined) {
            assert(typeof timezone === 'string' && timezone.trim().length > 0, 400, 'Invalid timezone format.');
            updates.timezone = timezone;
            hasUpdate = true;
        }
        if (profileImageUrl !== undefined) {
            assert(
                profileImageUrl === null || typeof profileImageUrl === 'string',
                400,
                'profileImageUrl must be a string or null.'
            );
            updates.profileImageUrl = profileImageUrl;
            hasUpdate = true;
        }
        if (availableHoursPerWeek !== undefined) {
            assert(
                typeof availableHoursPerWeek === 'number' && Number.isFinite(availableHoursPerWeek),
                400,
                'availableHoursPerWeek must be a number.'
            );
            assert(
                availableHoursPerWeek >= 0 && availableHoursPerWeek <= MAX_AVAILABLE_HOURS,
                400,
                `availableHoursPerWeek must be between 0 and ${MAX_AVAILABLE_HOURS}.`
            );
            const activeHours = await sumActiveGoalHours(userId);
            if (availableHoursPerWeek < activeHours) {
                const conflicts = await collectActiveGoalSummaries(userId);
                throw new ApiError(
                    409,
                    `Available hours (${availableHoursPerWeek}h/week) are insufficient for current active goals (${activeHours}h/week required).`,
                    {
                        availableHoursPerWeek,
                        requiredHoursPerWeek: activeHours,
                        conflictingGoals: conflicts,
                    }
                );
            }
            updates.availableHoursPerWeek = availableHoursPerWeek;
            hasUpdate = true;
        }

        assert(hasUpdate, 400, 'No updatable fields provided.');
        const updatedUser = await updateUser(userId, updates);
        res.json({ data: serializeUser(updatedUser) });
    } catch (error) {
        next(error);
    }
});

app.post('/v1/goals', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const user = await findUserById(userId);
        assert(user, 404, 'User not found.');

        const { title, description, minHoursPerWeek, priority, color } = req.body ?? {};
        assert(typeof title === 'string' && title.trim().length > 0, 400, 'title is required.');
        assert(
            typeof minHoursPerWeek === 'number' && Number.isFinite(minHoursPerWeek) && minHoursPerWeek >= 0,
            400,
            'minHoursPerWeek must be a non-negative number.'
        );
        assert(typeof priority === 'number' && Number.isInteger(priority), 400, 'priority must be an integer.');
        if (color !== undefined) {
            assert(typeof color === 'number' && Number.isFinite(color), 400, 'color must be a number.');
        }

        const existingHours = await sumActiveGoalHours(userId);
        const totalHours = existingHours + minHoursPerWeek;
        if (totalHours > user.availableHoursPerWeek) {
            const conflicts = await collectActiveGoalSummaries(userId);
            throw new ApiError(
                409,
                `Available hours (${user.availableHoursPerWeek}h/week) are insufficient for current active goals (${totalHours}h/week with new goal).`,
                {
                    availableHoursPerWeek: user.availableHoursPerWeek,
                    requiredHoursPerWeek: totalHours,
                    conflictingGoals: conflicts,
                }
            );
        }

        const goal = await createGoal({
            userId,
            title: title.trim(),
            description: typeof description === 'string' ? description : null,
            minHoursPerWeek,
            priority,
            color: color ?? null,
        });
        res.status(201).json({ data: serializeGoal(goal) });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/goals', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
        let status: GoalStatus | 'all' = 'all';
        if (statusParam) {
            if (statusParam === 'all') {
                status = 'all';
            } else {
                assert(isValidGoalStatus(statusParam), 400, 'Invalid status filter.');
                status = statusParam as GoalStatus;
            }
        }

        const goals = await listGoals({ userId, status });
        const payload = await Promise.all(
            goals.map(async (goal) => {
                const metrics = summarizeTaskHours(await listTasksByGoal(goal.id));
                return {
                    ...serializeGoal(goal),
                    totalTaskHours: metrics.totalTaskHours,
                    doneTaskHours: metrics.doneTaskHours,
                };
            })
        );
        res.json({ data: payload });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/goals/:goalId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const goal = await assertOwnedGoal(req.params.goalId, userId);
        res.json({ data: serializeGoal(goal) });
    } catch (error) {
        next(error);
    }
});

app.patch('/v1/goals/:goalId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const goal = await assertOwnedGoal(req.params.goalId, userId);

        const { title, description, status, minHoursPerWeek, priority, color } = req.body ?? {};
        const updates: Parameters<typeof updateGoal>[1] = {};
        let hasUpdate = false;

        if (title !== undefined) {
            assert(typeof title === 'string' && title.trim().length > 0, 400, 'Invalid title.');
            updates.title = title.trim();
            hasUpdate = true;
        }
        if (description !== undefined) {
            assert(description === null || typeof description === 'string', 400, 'description must be a string or null.');
            updates.description = description;
            hasUpdate = true;
        }
        if (status !== undefined) {
            assert(isValidGoalStatus(status), 400, 'Invalid goal status.');
            updates.status = status;
            hasUpdate = true;
        }
        if (minHoursPerWeek !== undefined) {
            assert(
                typeof minHoursPerWeek === 'number' && Number.isFinite(minHoursPerWeek) && minHoursPerWeek >= 0,
                400,
                'minHoursPerWeek must be a non-negative number.'
            );
            updates.minHoursPerWeek = minHoursPerWeek;
            hasUpdate = true;
        }
        if (priority !== undefined) {
            assert(typeof priority === 'number' && Number.isInteger(priority), 400, 'priority must be an integer.');
            updates.priority = priority;
            hasUpdate = true;
        }
        if (color !== undefined) {
            assert(color === null || (typeof color === 'number' && Number.isFinite(color)), 400, 'color must be a number or null.');
            updates.color = color;
            hasUpdate = true;
        }

        assert(hasUpdate, 400, 'No updatable fields provided.');

        const user = await findUserById(userId);
        assert(user, 404, 'User not found.');

        const nextStatus = (updates.status ?? goal.status) as GoalStatus;
        const nextHours = updates.minHoursPerWeek ?? goal.minHoursPerWeek;
        if (nextStatus === 'active') {
            const otherHours = await sumActiveGoalHours(userId, goal.id);
            const totalHours = otherHours + nextHours;
            if (totalHours > user.availableHoursPerWeek) {
                const conflicts = await collectActiveGoalSummaries(userId, goal.id);
                conflicts.push({ goalId: goal.id, title: goal.title, weeklyHours: nextHours });
                throw new ApiError(
                    409,
                    `Available hours (${user.availableHoursPerWeek}h/week) are insufficient for current active goals (${totalHours}h/week required).`,
                    {
                        availableHoursPerWeek: user.availableHoursPerWeek,
                        requiredHoursPerWeek: totalHours,
                        conflictingGoals: conflicts,
                    }
                );
            }
        }

        const updatedGoal = await updateGoal(goal.id, updates);
        res.json({ data: serializeGoal(updatedGoal) });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/goals/:goalId/metrics', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        await assertOwnedGoal(req.params.goalId, userId);
        const metrics = await computeGoalMetrics(req.params.goalId);
        res.json({ data: metrics });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/goals/:goalId/milestones', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        await assertOwnedGoal(req.params.goalId, userId);
        const milestones = await listMilestonesByGoal(req.params.goalId);
        res.json({ data: milestones.map(serializeMilestone) });
    } catch (error) {
        next(error);
    }
});

app.post('/v1/goals/:goalId/milestones', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const goal = await assertOwnedGoal(req.params.goalId, userId);

        const { title, description, parentMilestoneId } = req.body ?? {};
        assert(typeof title === 'string' && title.trim().length > 0, 400, 'title is required.');
        if (description !== undefined) {
            assert(description === null || typeof description === 'string', 400, 'description must be a string or null.');
        }
        if (parentMilestoneId !== undefined) {
            assert(typeof parentMilestoneId === 'string' && parentMilestoneId.trim().length > 0, 400, 'parentMilestoneId must be a string.');
            const parentMilestone = await assertOwnedMilestone(parentMilestoneId, userId);
            assert(parentMilestone.goalId === goal.id, 400, 'parentMilestoneId must belong to the same goal.');
        }

        const milestone = await createMilestone({
            goalId: goal.id,
            title: title.trim(),
            description: description ?? null,
            parentMilestoneId: parentMilestoneId ?? null,
        });
        res.status(201).json({ data: serializeMilestone(milestone) });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/milestones/:milestoneId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const milestone = await assertOwnedMilestone(req.params.milestoneId, userId);
        res.json({ data: serializeMilestone(milestone) });
    } catch (error) {
        next(error);
    }
});

app.patch('/v1/milestones/:milestoneId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        await assertOwnedMilestone(req.params.milestoneId, userId);

        const { title, description, status } = req.body ?? {};
        const updates: Parameters<typeof updateMilestone>[1] = {};
        let hasUpdate = false;

        if (title !== undefined) {
            assert(typeof title === 'string' && title.trim().length > 0, 400, 'Invalid title.');
            updates.title = title.trim();
            hasUpdate = true;
        }
        if (description !== undefined) {
            assert(description === null || typeof description === 'string', 400, 'description must be a string or null.');
            updates.description = description;
            hasUpdate = true;
        }
        if (status !== undefined) {
            assert(isValidMilestoneStatus(status), 400, 'Invalid milestone status.');
            updates.status = status;
            hasUpdate = true;
        }

        assert(hasUpdate, 400, 'No updatable fields provided.');
        const updated = await updateMilestone(req.params.milestoneId, updates);
        res.json({ data: serializeMilestone(updated) });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/milestones/:milestoneId/metrics', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        await assertOwnedMilestone(req.params.milestoneId, userId);
        const metrics = await computeMilestoneMetrics(req.params.milestoneId);
        res.json({ data: metrics });
    } catch (error) {
        next(error);
    }
});

app.post(
    '/v1/milestones/:milestoneId/tasks',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.user?.userId;
            assert(userId, 401, 'Unauthorized');
            const milestone = await assertOwnedMilestone(req.params.milestoneId, userId);

            const { title, description, date, estimatedHours } = req.body ?? {};
            assert(typeof title === 'string' && title.trim().length > 0, 400, 'title is required.');
            if (description !== undefined) {
                assert(
                    description === null || typeof description === 'string',
                    400,
                    'description must be a string or null.'
                );
            }
            const taskDate = validateIsoDate(date);
            const hours = validateEstimatedHours(estimatedHours);

            await ensureNoTaskConflict(milestone.id, userId, taskDate);

            const task = await createTask({
                goalId: milestone.goalId,
                milestoneId: milestone.id,
                userId,
                title: title.trim(),
                description: description ?? null,
                date: taskDate,
                estimatedHours: hours,
            });
            res.status(201).json({ data: serializeTask(task) });
        } catch (error) {
            next(error);
        }
    }
);

app.get('/v1/tasks/:taskId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const { task } = await assertOwnedTask(req.params.taskId, userId);
        res.json({ data: serializeTask(task) });
    } catch (error) {
        next(error);
    }
});

app.patch('/v1/tasks/:taskId', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const { task, milestone } = await assertOwnedTask(req.params.taskId, userId);

        const { title, description, date, estimatedHours, done } = req.body ?? {};
        const updates: Parameters<typeof updateTask>[1] = {};
        let hasUpdate = false;

        if (title !== undefined) {
            assert(typeof title === 'string' && title.trim().length > 0, 400, 'Invalid title.');
            updates.title = title.trim();
            hasUpdate = true;
        }
        if (description !== undefined) {
            assert(description === null || typeof description === 'string', 400, 'description must be a string or null.');
            updates.description = description;
            hasUpdate = true;
        }
        if (date !== undefined) {
            const newDate = validateIsoDate(date);
            await ensureNoTaskConflict(milestone.id, userId, newDate, task.id);
            updates.date = newDate;
            hasUpdate = true;
        }
        if (estimatedHours !== undefined) {
            updates.estimatedHours = validateEstimatedHours(estimatedHours);
            hasUpdate = true;
        }
        if (done !== undefined) {
            assert(typeof done === 'boolean', 400, 'done must be a boolean.');
            updates.done = done;
            hasUpdate = true;
        }

        assert(hasUpdate, 400, 'No updatable fields provided.');
        const updatedTask = await updateTask(task.id, updates);
        res.json({ data: serializeTask(updatedTask) });
    } catch (error) {
        next(error);
    }
});

app.post('/v1/tasks/:taskId/done', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const { task } = await assertOwnedTask(req.params.taskId, userId);
        const updatedTask = await setTaskDone(task.id, true);
        res.json({
            data: {
                id: updatedTask.id,
                status: updatedTask.done ? 'done' : 'not_yet_done',
                updatedAt: updatedTask.updatedAt,
            },
        });
    } catch (error) {
        next(error);
    }
});

app.post('/v1/tasks/:taskId/undone', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const { task } = await assertOwnedTask(req.params.taskId, userId);
        const updatedTask = await setTaskDone(task.id, false);
        res.json({
            data: {
                id: updatedTask.id,
                status: updatedTask.done ? 'done' : 'not_yet_done',
                updatedAt: updatedTask.updatedAt,
            },
        });
    } catch (error) {
        next(error);
    }
});

app.get('/v1/tasks:query', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.user?.userId;
        assert(userId, 401, 'Unauthorized');
        const day = typeof req.query.day === 'string' ? req.query.day : '';
        assert(day, 400, 'day query parameter is required.');
        assert(isValidDay(day), 400, 'Invalid day format. Use YYYY-MM-DD.');
        const { start, end } = toDayRange(day);
        const tasks = await listTasksByDateRange(userId, start, end);
        const pending = tasks.filter((task) => !task.done);
        res.json({ data: pending.map(serializeTask) });
    } catch (error) {
        next(error);
    }
});

app.get(
    '/v1/agent/goal/session:latest',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.user?.userId;
            assert(userId, 401, 'Unauthorized');
            let session = await findLatestActiveSession(userId);
            if (session) {
                res.json({ data: serializeSession(session) });
                return;
            }

            const user = await findUserById(userId);
            assert(user, 404, 'User not found.');
            const context = await buildUserContext(user);
            session = await createSession({ userId, context });
            res.status(201).json({ data: serializeSession(session) });
        } catch (error) {
            next(error);
        }
    }
);

app.post(
    '/v1/agent/goal/session:message',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.user?.userId;
            assert(userId, 401, 'Unauthorized');

            const { sessionId, message, goalPreview, userId: payloadUserId } = req.body ?? {};
            assert(typeof sessionId === 'string' && sessionId.trim().length > 0, 400, 'sessionId is required.');
            assert(typeof message === 'string' && message.trim().length > 0, 400, 'message is required.');
            if (payloadUserId !== undefined) {
                assert(payloadUserId === userId, 401, 'Unauthorized.');
            }

            const session = await findSessionById(sessionId);
            assert(session, 400, `Session '${sessionId}' not found.`);
            assert(session.userId === userId, 401, 'Unauthorized.');
            assert(session.sessionActive, 409, `Session '${sessionId}' is finalized and cannot accept new messages.`);

            const user = await findUserById(userId);
            assert(user, 404, 'User not found.');
            const contextSnapshot = await buildUserContext(user);
            const shouldInitRemoteSession = session.iteration === 0;

            let previewForContext = asRecord(goalPreview);
            if (!previewForContext && session.goalPreviewId) {
                const storedPreview = await findGoalPreviewById(session.goalPreviewId);
                previewForContext = storedPreview?.data ?? undefined;
            }

            await appendChatMessage({
                chatId: session.chatId,
                sessionId: session.id,
                sender: 'user',
                message,
            });

            if (shouldInitRemoteSession) {
                await initRemoteSession(userId, session.id);
            }

            const agentPayload = buildAgentInvocationPayload({
                userId,
                sessionId: session.id,
                message,
                goalPreview: previewForContext,
                availableHoursLeft: contextSnapshot.availableHoursLeft,
                upcomingTasks: contextSnapshot.upcomingTasks,
            });
            
            const agentResponse = await invokeAgentService(agentPayload);

            await appendChatMessage({
                chatId: session.chatId,
                sessionId: session.id,
                sender: 'agent',
                message: agentResponse.reply,
            });

            let goalPreviewId = session.goalPreviewId ?? null;
            let sessionActive = agentResponse.state?.sessionActive ?? session.sessionActive;
            let updatedContext = agentResponse.context ?? contextSnapshot;
            let responseAction = agentResponse.action
                ? {
                      ...agentResponse.action,
                      payload: agentResponse.action.payload
                          ? { ...(agentResponse.action.payload as Record<string, unknown>) }
                          : undefined,
                  }
                : undefined;
            const actionPayload = (responseAction?.payload as Record<string, unknown> | undefined) ?? undefined;

            if (responseAction?.type === 'save_preview') {
                const preview = extractPreviewPayload(actionPayload);
                const previewRecord = await upsertGoalPreview({
                    id: preview.id,
                    userId,
                    sessionId: session.id,
                    data: preview.data,
                });
                goalPreviewId = previewRecord.id;
                responseAction = {
                    ...responseAction,
                    payload: {
                        ...(responseAction.payload as Record<string, unknown> | undefined),
                        goalPreviewId,
                    },
                };
            } else if (responseAction?.type === 'finalize_goal') {
                const finalizePayload = actionPayload ?? {};
                const finalizeResult = await finalizeGoalPlanFromAgentPayload(user, finalizePayload);
                goalPreviewId = finalizeResult.goalPreviewId ?? goalPreviewId;
                sessionActive = false;
                responseAction = {
                    ...responseAction,
                    payload: {
                        ...(responseAction.payload as Record<string, unknown> | undefined),
                        goalId: finalizeResult.goal.id,
                        milestoneIds: finalizeResult.milestoneIds,
                        taskIds: finalizeResult.taskIds,
                        goalPreviewId,
                    },
                };
                updatedContext = await buildUserContext(user);
            }

            const updatedSession = await updateSession(session.id, {
                state: agentResponse.state?.state ?? session.state,
                iteration: agentResponse.state?.iteration ?? session.iteration + 1,
                goalPreviewId: agentResponse.state?.goalPreviewId ?? goalPreviewId,
                sessionActive,
                context: updatedContext,
            });
            
            console.log(agentResponse.action.payload?.goalPreview);

            res.json({
                sessionId: updatedSession.id,
                reply: agentResponse.reply,
                action: responseAction ?? agentResponse.action,
                state: {
                    state: updatedSession.state,
                    iteration: updatedSession.iteration,
                    sessionActive: updatedSession.sessionActive,
                    goalPreviewId: updatedSession.goalPreviewId ?? null,
                },
                context: updatedSession.context,
            });
        } catch (error) {
            next(error);
        }
    }
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
        const errorBody: Record<string, unknown> = {
            error: {
                code: err.status,
                message: err.message,
            },
        };
        if (err.details !== undefined) {
            (errorBody.error as Record<string, unknown>).details = err.details;
        }
        res.status(err.status).json(errorBody);
        return;
    }

    console.error(err);
    res.status(500).json({ error: { code: 500, message: 'Internal server error.' } });
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
