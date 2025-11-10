export type GoalStatus = 'active' | 'completed' | 'archived' | 'paused';

export interface UserRecord {
    id: string;
    email: string;
    name: string;
    profileImageUrl: string | null;
    timezone: string;
    availableHoursPerWeek: number;
    createdAt: string;
    updatedAt: string;
    googleSub: string;
}

export interface GoalRecord {
    id: string;
    userId: string;
    title: string;
    description?: string | null;
    status: GoalStatus;
    color?: number | null;
    hoursPerWeek: number;
    priority: number;
    milestones: string[];
    createdAt: string;
    updatedAt: string;
}

export type MilestoneStatus = 'blocked' | 'in_progress' | 'finished';

export interface MilestoneRecord {
    id: string;
    goalId: string;
    parentMilestoneId?: string | null;
    title: string;
    description?: string | null;
    status: MilestoneStatus;
    tasks: string[];
    createdAt: string;
    updatedAt: string;
}

export interface TaskRecord {
    id: string;
    goalId: string;
    milestoneId: string;
    userId: string;
    title: string;
    description?: string | null;
    date: string;
    estimatedHours: number;
    done: boolean;
    createdAt: string;
    updatedAt: string;
}

export type SessionStateValue = 'plan_generated' | 'finalized' | 'draft' | 'in_progress';

export interface SessionStateRecord {
    id: string;
    userId: string;
    chatId: string;
    state: SessionStateValue;
    iteration: number;
    goalPreviewId?: string | null;
    sessionActive: boolean;
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface ChatMessageRecord {
    id?: string;
    sessionId: string;
    chatId: string;
    sender: 'user' | 'agent';
    message: string;
    createdAt: string;
}

export interface AgentAction {
    type: 'save_preview' | 'finalize_goal' | 'none';
    payload?: Record<string, unknown>;
}

export interface AgentServiceResponse {
    reply: string;
    action: AgentAction;
    state: {
        state: SessionStateValue;
        iteration: number;
        sessionActive: boolean;
        goalPreviewId?: string | null;
    };
    context?: Record<string, unknown>;
}
