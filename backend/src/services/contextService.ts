import { sumActiveGoalHours } from '../repositories/goalRepository';
import { listIncompleteTasksByUser } from '../repositories/taskRepository';
import { UserRecord } from '../types/models';

export interface UserContextSnapshot extends Record<string, unknown> {
    availableHoursLeft: number;
    upcomingTasks: Array<{
        id: string;
        title: string;
        goalId: string;
        milestoneId: string;
        date: string;
        estimatedHours: number;
        done: boolean;
    }>;
}

export async function buildUserContext(user: UserRecord): Promise<UserContextSnapshot> {
    const tasks = await listIncompleteTasksByUser(user.id);
    const upcomingTasks = tasks
        .map((task) => ({
            id: task.id,
            title: task.title,
            goalId: task.goalId,
            milestoneId: task.milestoneId,
            date: task.date,
            estimatedHours: task.estimatedHours,
            done: task.done,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

    const activeGoalHours = await sumActiveGoalHours(user.id);
    const availableHoursLeft = Math.max(0, user.availableHoursPerWeek - activeGoalHours);

    return {
        availableHoursLeft,
        upcomingTasks,
    };
}
