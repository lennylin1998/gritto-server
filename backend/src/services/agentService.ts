import { ApiError } from '../errors';
import { AgentServiceResponse } from '../types/models';

type AgentMessagePart =
    | { text: string }
    | {
          function_call: {
              name: string;
              args: Record<string, unknown>;
          };
      };

export interface AgentInvocationPayload {
    app_name: string;
    user_id: string;
    session_id: string;
    new_message: {
        role: 'user';
        parts: AgentMessagePart[];
    };
}

export interface BuildAgentPayloadOptions {
    userId: string;
    sessionId: string;
    message: string;
    goalPreview?: Record<string, unknown> | null;
    availableHoursLeft?: number;
    upcomingTasks?: unknown[];
    appName?: string;
}

function getAgentServiceUrl(): string {
    const url = process.env.AGENT_APP_URL ?? process.env.AGENT_SERVICE_URL;
    if (!url) {
        throw new ApiError(500, 'Agent service URL not configured.');
    }
    return url.replace(/\/$/, '');
}

function buildAgentHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (process.env.AGENT_SERVICE_AUTH_TOKEN) {
        headers.Authorization = `Bearer ${process.env.AGENT_SERVICE_AUTH_TOKEN}`;
    }
    return headers;
}

async function postAgentJson(url: string, body: unknown, allowedErrorStatuses: number[] = []): Promise<Response> {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: buildAgentHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok && !allowedErrorStatuses.includes(response.status)) {
            const message = await response.text();
            if (response.status === 503) {
                throw new ApiError(503, 'Agent service unavailable. Please try again later.');
            }
            throw new ApiError(response.status, message || 'Agent service error.');
        }
        return response;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(503, 'Agent service unavailable. Please try again later.');
    }
}

export async function initRemoteSession(userId: string, sessionId: string): Promise<void> {
    const preferredLanguage = process.env.AGENT_PREFERRED_LANGUAGE ?? 'English';
    const baseUrl = getAgentServiceUrl();
    const url = `${baseUrl}/apps/goal_planning_agent/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(
        sessionId
    )}`;
    await postAgentJson(
        url,
        {
            preferred_language: preferredLanguage,
            init: true,
        },
        [409]
    );
}

export function buildAgentInvocationPayload(options: BuildAgentPayloadOptions): AgentInvocationPayload {
    const appName = options.appName ?? process.env.AGENT_APP_NAME ?? 'goal_planning_agent';
    const parts: AgentMessagePart[] = [{ text: options.message }];

    if (options.goalPreview && Object.keys(options.goalPreview).length > 0) {
        parts.push({
            function_call: {
                name: 'goal_preview_context',
                args: { goalPreview: options.goalPreview },
            },
        });
    }

    if (typeof options.availableHoursLeft === 'number') {
        parts.push({
            function_call: {
                name: 'time_context',
                args: { availableHoursLeft: options.availableHoursLeft },
            },
        });
    }

    if (options.upcomingTasks && Array.isArray(options.upcomingTasks) && options.upcomingTasks.length > 0) {
        parts.push({
            function_call: {
                name: 'task_context',
                args: { upcomingTasks: options.upcomingTasks },
            },
        });
    }

    return {
        app_name: appName,
        user_id: options.userId,
        session_id: options.sessionId,
        new_message: {
            role: 'user',
            parts,
        },
    };
}

export async function invokeAgentService(payload: AgentInvocationPayload): Promise<AgentServiceResponse> {
    const url = `${getAgentServiceUrl()}/run`;
    const response = await postAgentJson(url, payload);
    const data = (await response.json())[2].actions.stateDelta.final_response;
    console.log(data);
    return data as AgentServiceResponse;
}
