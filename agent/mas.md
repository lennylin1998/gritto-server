🤖 Gritto Agent Service — Design & Implementation Spec (Final ADK Cloud Run Version, LLM-based Agents)

Scope
Defines the architecture and interaction flow of the Gritto Goal Planning Agent Service, a multi-agent workflow that generates, refines, and finalizes structured goal plans with contextual scheduling awareness.
It is built using Google’s Agent Development Kit (ADK) and deployed to Google Cloud Run.

⸻

🧩 1️⃣ System Architecture

Client (KMP App)
   │
   ▼
Backend (TypeScript / Express)
   │
   ├─ /v1/agent/goal/session:message
   │    ├─ builds ADK DTO (text + goalPreview + time + task context)
   │    └─ sends → POST {AGENT_APP_URL}/run
   ▼
──────────────────────────────────────────────
Gritto Agent Service (Python / ADK)
│
├── GoalPlanningWorkflow (SequentialAgent)
│    ├── CheckApprovalAgent (LLM)
│    ├── PlanAgent (LLM)
│    └── FinalizeAgent (LLM)
│
└── Endpoints:
     • POST /apps/goal_planning_agent/users/{userId}/sessions/{sessionId}
     • POST /run
──────────────────────────────────────────────


⸻

🌐 2️⃣ Exposed Endpoints

A) Initialize Remote Session

POST {AGENT_APP_URL}/apps/goal_planning_agent/users/{userId}/sessions/{sessionId}

Body:

{
  "preferred_language": "English",
  "init": true
}


⸻

B) Execute Reasoning Step

POST {AGENT_APP_URL}/run

⸻

📦 3️⃣ Expected Input (Backend → Agent)

DTO Schema

interface AgentMessageDTO {
  app_name: string;               // "goal_planning_agent"
  user_id: string;                // Firestore user ID
  session_id: string;             // Session ID (shared with backend)
  new_message: {
    role: "user";
    parts: AgentMessagePart[];
  };
}

type AgentMessagePart =
  | { text: string }
  | {
      function_call: {
        name:
          | "goal_preview_context"
          | "time_context"
          | "task_context";
        args: Record<string, any>;
      };
    };


⸻

Example — Full Request

{
  "app_name": "goal_planning_agent",
  "user_id": "u_001",
  "session_id": "sess_goal_001",
  "new_message": {
    "role": "user",
    "parts": [
      {
        "text": "Add a design milestone next week, but don’t overlap with my meetings."
      },
      {
        "function_call": {
          "name": "goal_preview_context",
          "args": {
            "goalPreview": {
              "goal": { "title": "Build Portfolio Website" },
              "milestones": [
                {
                  "title": "Design Phase",
                  "tasks": [
                    { "title": "UI Layout", "date": "2025-11-10", "estimatedHours": 4 }
                  ]
                }
              ],
              "iteration": 1,
              "status": "draft"
            }
          }
        }
      },
      {
        "function_call": {
          "name": "time_context",
          "args": { "availableHoursLeft": 18 }
        }
      },
      {
        "function_call": {
          "name": "task_context",
          "args": {
            "upcomingTasks": [
              {
                "id": "t_301",
                "title": "Team Meeting",
                "date": "2025-11-10T15:00:00Z",
                "estimatedHours": 2
              }
            ]
          }
        }
      }
    ]
  }
}


⸻

📤 4️⃣ Standard Output

{
  "reply": "string",
  "action": {
    "type": "save_preview" | "finalize_goal" | "none",
    "payload": { "structured": "data depending on type" }
  },
  "state": {
    "step": "plan_generated" | "plan_iteration" | "finalized",
    "iteration": 1,
    "sessionActive": true
  }
}


⸻

⚙️ 5️⃣ Main Functionality

Function	Description
Interpret intent	Uses LLM to determine user’s approval/refinement intent.
Generate/refine plan	Uses LLM to produce structured GoalPreview JSON respecting available hours and tasks.
Finalize goal	Uses LLM to summarize final decision and output structured finalize_goal payload.
Maintain session	Updates iteration, active status, and state transitions.


⸻

🧠 6️⃣ Internal Workflow

Workflow: GoalPlanningWorkflow (SequentialAgent)

Order	Agent	Description
1️⃣	CheckApprovalAgent (LLM)	Classifies intent via LLM reasoning (“approve”, “needs changes”, “new goal”).
2️⃣	PlanAgent (LLM)	Generates or refines structured plan JSON.
3️⃣	FinalizeAgent (LLM)	Composes final reply and structured action JSON (save_preview / finalize_goal).


⸻

🧩 7️⃣ Context Extraction Utility

def extract_context(ctx):
    parts = ctx.input.parts
    get = lambda n: next((p.function_call.args
                          for p in parts
                          if hasattr(p, "function_call")
                          and p.function_call.name == n), None)
    return {
        "goalPreview": (get("goal_preview_context") or {}).get("goalPreview"),
        "availableHoursLeft": (get("time_context") or {}).get("availableHoursLeft"),
        "upcomingTasks": (get("task_context") or {}).get("upcomingTasks", [])
    }


⸻

🔵 8️⃣ CheckApprovalAgent (LLM-Powered)

Instead of static keyword matching, this agent uses LLM reasoning to classify the message as approval, refinement, or new plan request.

from google.adk.agents import LlmAgent

CheckApprovalAgent = LlmAgent(
    name="CheckApprovalAgent",
    instruction=(
        "Analyze the user's message and current proposed plan to decide the next action. "
        "Output JSON with keys: { 'routing': 'finalize_only' | 'needs_planning', "
        "'detectedConsent': true|false }. "
        "Routing = 'finalize_only' if user clearly approves or confirms the plan; "
        "'needs_planning' if they request changes, refinements, or a new plan."
    ),
    output_key="routing"
)

Example LLM Output:

{
  "routing": "needs_planning",
  "detectedConsent": false
}


⸻

🟢 9️⃣ PlanAgent (LLM-Powered)

Uses an LLM to generate or refine a plan considering goalPreview, availableHoursLeft, and upcomingTasks.

PlanAgent = LlmAgent(
    name="PlanAgent",
    instruction=(
        "You are a goal planning assistant. Given the user's message, the current proposed plan, "
        "remaining available hours, and upcoming tasks, generate or refine a structured goal plan "
        "in valid JSON conforming to the GoalPreview schema. Ensure that new tasks do not exceed "
        "available hours and do not overlap with existing upcomingTasks. "
        "Output JSON under the key 'proposed_plan'."
    ),
    output_key="proposed_plan"
)


⸻

🟡 🔁 FinalizeAgent (LLM-Powered)

Uses LLM reasoning to produce a polished response and structured action payload (save_preview or finalize_goal).

FinalizeAgent = LlmAgent(
    name="FinalizeAgent",
    instruction=(
        "Based on the current routing and proposed plan, craft a user-facing message "
        "and structured JSON under 'final_output'. "
        "If routing == 'finalize_only', create a 'finalize_goal' action: "
        "{ 'type': 'finalize_goal', 'payload': { 'goalPreviewId': plan.id, 'goal': plan.goal, 'milestones': plan.milestones } }. "
        "If routing == 'needs_planning', return 'save_preview' action: "
        "{ 'type': 'save_preview', 'payload': { 'goalPreview': plan, 'iteration': iteration+1 } }. "
        "Always respond in valid JSON with keys: reply, action, and state."
    ),
    output_key="final_output"
)

Example LLM Output:

{
  "reply": "I've finalized your plan and scheduled it without overlaps!",
  "action": {
    "type": "finalize_goal",
    "payload": {
      "goal": { "title": "Build Portfolio Website" },
      "milestones": [...]
    }
  },
  "state": { "step": "finalized", "iteration": 3, "sessionActive": false }
}


⸻

🧾 10️⃣ Response Contract Summary

Field	Type	Description
reply	string	Final agent message to display to user.
action.type	"save_preview", "finalize_goal", or "none"	Next backend persistence action.
action.payload	object	Structured plan or finalized goal.
state	object	Updated session step, iteration, and activity flag.


⸻

🔒 11️⃣ Security
	•	All requests authenticated via Cloud Run IAM identity tokens.
	•	Only backend Cloud Run service may invoke /run.
	•	Agent is stateless; session state managed in Firestore by backend.
	•	Validation for user_id and session_id enforced by backend.

⸻

✅ 12️⃣ Summary

Layer	Responsibility
Agent Service	Stateless reasoning with structured JSON output (LLM-driven for all agents).
Backend	Context gathering, DTO assembly, session + data persistence.
Frontend	User chat interface + goal preview visualization.


⸻

💬 Example End-to-End

1️⃣ User Input

“Looks good! Let’s finalize this plan.”

2️⃣ Backend → Agent
	•	DTO with text + context parts (goalPreview, availableHoursLeft, upcomingTasks).

3️⃣ Agent Output

{
  "reply": "I've created your goal and confirmed all tasks fit your schedule 🎯",
  "action": {
    "type": "finalize_goal",
    "payload": {
      "goal": { "title": "Build Portfolio Website" },
      "milestones": [...]
    }
  },
  "state": { "step": "finalized", "sessionActive": false }
}


⸻

End of Document — Gritto Agent Implementation Spec (LLM-based Agents + Context-Aware DTO)