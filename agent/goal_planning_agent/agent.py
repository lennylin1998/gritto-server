from __future__ import annotations

from dotenv import load_dotenv
import json
import os
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from google.adk.agents import BaseAgent, LlmAgent, SequentialAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.events import Event, EventActions
from google.genai import types
from pydantic import BaseModel, Field, field_validator

from .llm import GeminiJsonResponder

load_dotenv()
_MODEL_NAME = os.getenv("AGENT_LLM_MODEL")
_API_KEY = os.getenv("GOOGLE_API_KEY")
_STRICT = os.getenv("AGENT_STRICT_LLM", "false").lower() in {"1", "true", "yes"}
_APP_NAME = "goal_planning_agent"

_json_responder = GeminiJsonResponder(model_name=_MODEL_NAME, api_key=_API_KEY)


def _text_content(message: str) -> types.Content:
    return types.Content(parts=[types.Part(text=message)])


def _deepcopy_json(value: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return json.loads(json.dumps(value, default=str))
    except TypeError:
        try:
            return dict(value)
        except Exception:
            return value


def _get_input_obj(ctx) -> Any:
    return getattr(ctx, "input", None)


def _get_parts(ctx) -> List[Any]:
    content = _get_input_obj(ctx)
    parts = getattr(content, "parts", None)
    if isinstance(parts, list):
        return parts
    return []


def _part_text(part: Any) -> Optional[str]:
    if hasattr(part, "text"):
        text_value = getattr(part, "text")
        if isinstance(text_value, str):
            return text_value
    if isinstance(part, dict):
        text_value = part.get("text")
        if isinstance(text_value, str):
            return text_value
    return None


def _get_function_call(part: Any) -> Optional[Any]:
    if hasattr(part, "function_call"):
        return getattr(part, "function_call")
    if isinstance(part, dict):
        return part.get("function_call")
    return None


def _get_attr(obj: Any, key: str) -> Optional[Any]:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


# def _extract_user_message(ctx) -> str:
#     content = _get_input_obj(ctx)
#     if content is None:
#         return ""

#     direct_message = getattr(content, "message", None)
#     if isinstance(direct_message, str) and direct_message.strip():
#         return direct_message.strip()

#     text_attr = getattr(content, "text", None)
#     if isinstance(text_attr, str) and text_attr.strip():
#         return text_attr.strip()

#     for part in _get_parts(ctx):
#         text_value = _part_text(part)
#         if text_value and text_value.strip():
#             return text_value.strip()
#     return ""


# def _extract_context(ctx) -> Dict[str, Any]:
#     parts = _get_parts(ctx)

#     def _call_args(name: str) -> Dict[str, Any]:
#         for part in parts:
#             fn = _get_function_call(part)
#             if not fn:
#                 continue
#             fn_name = _get_attr(fn, "name")
#             if fn_name != name:
#                 continue
#             args = _get_attr(fn, "args")
#             if isinstance(args, dict):
#                 return args
#         return {}

#     goal_preview_ctx = _call_args("goal_preview_context")
#     time_ctx = _call_args("time_context")
#     task_ctx = _call_args("task_context")

#     return {
#         "goalPreview": goal_preview_ctx.get("goalPreview"),
#         "availableHoursLeft": time_ctx.get("availableHoursLeft"),
#         "upcomingTasks": task_ctx.get("upcomingTasks", []),
#     }


# def _sync_state_with_context(state: Dict[str, Any], context: Dict[str, Any]) -> None:
#     if not context:
#         return

#     state["context"] = _deepcopy_json(context)

#     goal_preview = context.get("goalPreview")
#     if goal_preview:
#         state["proposed_plan"] = _deepcopy_json(goal_preview)
#         iteration = goal_preview.get("iteration")
#         if isinstance(iteration, int):
#             state["iteration"] = iteration

def _my_before_model_cb(ctx: InvocationContext) -> None:
    """Populate session state with structured context before each LLM call."""

    content = getattr(ctx, "user_content", None)
    parts = getattr(content, "parts", None) if content is not None else None
    if not isinstance(parts, list):
        parts = []

    def _call_args(name: str) -> Dict[str, Any]:
        for part in parts:
            fn = getattr(part, "function_call", None)
            if fn is None and isinstance(part, dict):
                fn = part.get("function_call")
            if not fn:
                continue
            fn_name = getattr(fn, "name", None) if not isinstance(fn, dict) else fn.get("name")
            if fn_name != name:
                continue
            args = getattr(fn, "args", None) if not isinstance(fn, dict) else fn.get("args")
            if isinstance(args, dict):
                return args
        return {}

    goal_preview_args = _call_args("goal_preview_context")
    time_args = _call_args("time_context")
    task_args = _call_args("task_context")

    goal_preview = goal_preview_args.get("goalPreview")
    available_hours = time_args.get("availableHoursLeft")
    upcoming_tasks = task_args.get("upcomingTasks")

    state = ctx.session.state
    if goal_preview is not None:
        state["goal_preview"] = goal_preview
    if available_hours is not None:
        state["available_hours_left"] = available_hours
    if isinstance(upcoming_tasks, list):
        state["upcoming_tasks"] = upcoming_tasks

    # Mirrors the shape used elsewhere in the workflow so downstream agents
    # can rely on a single `context` dict within session state.
    context_payload = state.get("context")
    if not isinstance(context_payload, dict):
        context_payload = {}
    if goal_preview is not None:
        context_payload["goalPreview"] = goal_preview
    if available_hours is not None:
        context_payload["availableHoursLeft"] = available_hours
    if isinstance(upcoming_tasks, list):
        context_payload["upcomingTasks"] = upcoming_tasks
    state["context"] = context_payload
    state["timestamp"] = datetime.now(timezone.utc).isoformat()

    # Preserve compatibility with plan iteration state.
    if goal_preview and isinstance(goal_preview, dict):
        iteration = goal_preview.get("iteration")
        if isinstance(iteration, int):
            state["iteration"] = iteration

class PlanTaskSchema(BaseModel):
    title: str
    description: str
    date: datetime = Field(description="UTC time in ISO8601 format with 'Z' suffix")
    estimatedHours: float

    @field_validator("date", mode="before")
    def enforce_utc(cls, v):
        if isinstance(v, datetime):
            return v.astimezone(timezone.utc)
        return datetime.fromisoformat(v.replace("Z", "+00:00"))

class PlanMilestoneSchema(BaseModel):
    title: str
    description: str
    tasks: List[PlanTaskSchema] = Field(..., min_length=1)


class PlanGoalSchema(BaseModel):
    title: str
    description: str
    hoursPerWeek: int

class PlanOutputSchema(BaseModel):
    goal: PlanGoalSchema
    milestones: List[PlanMilestoneSchema] = Field(..., min_length=1)
    iteration: Optional[int] = None


def _plan_instruction(ctx: ReadonlyContext) -> str:
    state = ctx.state
    state_context = state.get("context", {}) or {}
    plan = state.get("proposed_plan") or state.get("goal_preview")
    available_hours = state_context.get("availableHoursLeft") or state.get("available_hours_left")
    upcoming_tasks = state_context.get("upcomingTasks") or state.get("upcoming_tasks") or []
    snapshot = {
        "existingPlan": plan,
        "availableHoursLeft": available_hours,
        "upcomingTasks": upcoming_tasks,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    context_json = json.dumps(snapshot, ensure_ascii=False, indent=2, default=str)
    return (
        "You are a goal planning assistant. Use the latest user input together with the context JSON below "
        "to generate or refine a single coherent goal plan."
        "When planning, first set hoursPerWeek for the goal, and respect availableHoursLeft."
        "The task estimatedHours should follow the hoursPerWeek. "
        "Avoid overlapping upcomingTasks, and keep milestones/task sequencing realistic for the provided timestamp. "
        "Always return STRICT JSON that matches the output_schema (top-level keys: goal, milestones and iteration)."
        f"\n\nPlanning context:\n{context_json}\n"
    )


def _plan_before_agent_callback(*, callback_context: CallbackContext):
    state = callback_context.state
    routing = state.get("routing") or "needs_planning"
    if routing == "finalize_only" and not state.get("proposed_plan"):
        routing = "needs_planning"
        state["routing"] = routing
    if routing == "finalize_only":
        return _text_content("Routing skip: finalize_only")
    return None

class CheckApprovalAgent(BaseAgent):
    def __init__(self, responder: GeminiJsonResponder, *, strict: bool = False) -> None:
        super().__init__(
            name="CheckApprovalAgent",
            description="Classifies whether the user approved the plan or requests refinements using LLM reasoning.",
        )
        self._responder = responder
        self._strict = strict

    async def _run_async_impl(self, ctx) -> AsyncGenerator[Event, None]:  # type: ignore[override]
        state = ctx.session.state
        incoming_message = ctx.user_content.parts[0].text
        state["user_goal_text"] = incoming_message

        print("=======DEBUG ctx: ", ctx)
        _my_before_model_cb(ctx)
        print("=======DEBUG updated state: ", ctx.session.state)

        has_plan = bool(state.get("proposed_plan"))

        snapshot = _deepcopy_json(state)
        decision = await self._responder.classify_approval(message=incoming_message, state_snapshot=snapshot)
        parsed, used_fallback = self._coerce_decision(decision, incoming_message, has_plan)
        if used_fallback and self._strict:
            raise RuntimeError("LLM routing decision failed strict validation.")

        updates = {
            "routing": parsed["routing"],
            "detectedConsent": parsed["detectedConsent"],
            "approval_decision": parsed,
        }
        if parsed.get("reason"):
            updates["approval_reason"] = parsed["reason"]

        state.update({k: v for k, v in updates.items() if v is not None})

        yield Event(
            author=self.name,
            content=_text_content(json.dumps(parsed, default=str)),
            actions=EventActions(state_delta=updates),
        )

    def _coerce_decision(
        self,
        decision: Optional[Dict[str, Any]],
        message: str,
        has_plan: bool,
    ) -> Tuple[Dict[str, Any], bool]:
        used_fallback = False
        parsed = decision or {}
        routing = parsed.get("routing") if isinstance(parsed.get("routing"), str) else None
        detected = parsed.get("detectedConsent")
        reason = parsed.get("reason") if isinstance(parsed.get("reason"), str) else None

        if routing not in {"finalize_only", "needs_planning"}:
            routing = None
        if not isinstance(detected, bool):
            detected = None

        if routing and routing == "finalize_only" and not has_plan:
            routing = "needs_planning"

        if routing is None or detected is None:
            fallback = self._fallback_decision(message, has_plan)
            routing = fallback["routing"]
            detected = fallback["detectedConsent"]
            reason = fallback["reason"]
            used_fallback = True

        resolved_reason = reason or ("LLM routing result" if decision is not None else "LLM routing fallback applied")

        return {
            "routing": routing,
            "detectedConsent": bool(detected),
            "reason": resolved_reason,
        }, used_fallback

    def _fallback_decision(self, message: str, has_plan: bool) -> Dict[str, Any]:
        user_text = (message or "").lower()
        positives = ["approve", "looks good", "yes", "okay", "save", "go ahead", "ship it"]
        negators = ["but", "however", "not yet", "change", "adjust", "later", "instead"]

        positive = any(token in user_text for token in positives)
        negative = any(token in user_text for token in negators)

        detected = bool(positive and not negative)
        routing = "finalize_only" if detected and has_plan else "needs_planning"
        reason = "Heuristic approval detected" if detected else "Defaulting to further planning"
        return {"routing": routing, "detectedConsent": detected, "reason": reason}


_plan_agent = LlmAgent(
    name="PlanAgent",
    description="Generates or refines the goal preview JSON via Gemini through the ADK LlmAgent.",
    model=_MODEL_NAME or "gemini-1.5-pro-latest",
    instruction=_plan_instruction,
    before_agent_callback=_plan_before_agent_callback,
    output_key="proposed_plan",
    output_schema=PlanOutputSchema,
    generate_content_config=types.GenerateContentConfig(response_mime_type="application/json"),
)


class FinalizeAgent(BaseAgent):
    def __init__(self, responder: GeminiJsonResponder, *, strict: bool = False) -> None:
        super().__init__(
            name="FinalizeAgent",
            description="Creates the final reply and action payload for the backend via LLM reasoning.",
        )
        self._responder = responder
        self._strict = strict

    async def _run_async_impl(self, ctx) -> AsyncGenerator[Event, None]:  # type: ignore[override]
        state = ctx.session.state
        plan = _deepcopy_json(state.get("proposed_plan") or {})
        routing = state.get("routing") or "needs_planning"
        iteration = int(state.get("iteration") or 0)

        if routing == "finalize_only" and not plan:
            routing = "needs_planning"
            state["routing"] = routing

        snapshot = _deepcopy_json({**state, "routing": routing})
        llm_response = await self._responder.finalize_response(state_snapshot=snapshot, plan=plan)
        final_payload, used_fallback = self._coerce_final_response(
            llm_response,
            routing=routing,
            plan=plan,
            iteration=iteration,
        )
        if used_fallback and self._strict:
            raise RuntimeError("LLM finalization response failed strict validation.")

        action = final_payload["action"]
        state_updates = _deepcopy_json(final_payload["state"])

        action_copy = _deepcopy_json(action)
        updates: Dict[str, Any] = {**state_updates, "lastAction": action_copy, "user_goal_text": None}
        updates["final_response"] = _deepcopy_json(final_payload)

        state.update({k: v for k, v in updates.items() if v is not None})

        yield Event(
            author=self.name,
            content=_text_content(json.dumps(final_payload, default=str)),
            actions=EventActions(state_delta=updates),
        )

    def _coerce_final_response(
        self,
        response: Optional[Dict[str, Any]],
        *,
        routing: str,
        plan: Dict[str, Any],
        iteration: int,
    ) -> Tuple[Dict[str, Any], bool]:
        fallback = self._fallback_response(routing=routing, plan=plan, iteration=iteration)
        if response is None:
            return fallback, True

        reply = response.get("reply") if isinstance(response.get("reply"), str) else None
        action = response.get("action") if isinstance(response.get("action"), dict) else None
        new_state = response.get("state") if isinstance(response.get("state"), dict) else None

        if not (reply and action and new_state):
            return fallback, True

        action_type = action.get("type") if isinstance(action.get("type"), str) else None
        payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
        if action_type is None:
            return fallback, True

        result = {
            "reply": reply,
            "action": {"type": action_type, "payload": payload},
            "state": {},
        }

        coerced_state = self._normalize_state(
            new_state,
            routing=routing,
            iteration=iteration,
            action_type=action_type,
            plan=plan,
        )
        if coerced_state is None:
            return fallback, True
        result["state"] = coerced_state

        result["action"]["payload"] = self._enrich_payload(action_type, payload, plan, coerced_state)
        return result, False

    def _normalize_state(
        self,
        state: Dict[str, Any],
        *,
        routing: str,
        iteration: int,
        action_type: str,
        plan: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        coerced: Dict[str, Any] = {}
        plan_exists = bool(plan)

        if routing == "finalize_only" and plan_exists:
            if action_type != "finalize_goal":
                return None
            coerced_iteration = iteration
            coerced_step = "finalized"
            coerced_active = False
        else:
            if action_type not in {"save_preview", "none"}:
                # Allow "none" only if no plan exists to save.
                if action_type != "none":
                    return None
            if action_type == "none" and plan_exists:
                return None
            expected_iteration = iteration + (0 if action_type == "none" else 1)
            coerced_iteration = expected_iteration
            coerced_step = "plan_generated" if expected_iteration == 1 else "plan_iteration"
            coerced_active = action_type != "none"

        if "iteration" in state:
            try:
                coerced_iteration = int(state["iteration"])
            except (TypeError, ValueError):
                pass

        session_active = state.get("sessionActive")
        if isinstance(session_active, bool):
            coerced_active = session_active

        step_value = state.get("step") if isinstance(state.get("step"), str) else coerced_step

        coerced.update({
            "iteration": coerced_iteration,
            "sessionActive": coerced_active,
            "step": step_value,
        })
        return coerced

    def _enrich_payload(
        self,
        action_type: str,
        payload: Dict[str, Any],
        plan: Dict[str, Any],
        state: Dict[str, Any],
    ) -> Dict[str, Any]:
        enriched = json.loads(json.dumps(payload, default=str)) if payload else {}
        if action_type == "finalize_goal":
            enriched.setdefault("goalPreviewId", plan.get("id"))
            enriched.setdefault("goal", plan.get("goal", {}))
            enriched.setdefault("milestones", plan.get("milestones", []))
        elif action_type == "save_preview":
            enriched.setdefault("goalPreview", plan)
            enriched.setdefault("iteration", state.get("iteration"))
        return enriched

    def _fallback_response(self, *, routing: str, plan: Dict[str, Any], iteration: int) -> Dict[str, Any]:
        plan_exists = bool(plan)
        if routing == "finalize_only" and plan_exists:
            reply = f"I've created a goal for you: {plan.get('goal', {}).get('title', 'Your goal')} 🎯"
            action = {
                "type": "finalize_goal",
                "payload": {
                    "goalPreviewId": plan.get("id"),
                    "goal": plan.get("goal", {}),
                    "milestones": plan.get("milestones", []),
                },
            }
            state = {"step": "finalized", "sessionActive": False, "iteration": iteration}
        else:
            next_iteration = iteration + 1
            reply = (
                "Here’s a plan based on your message!" if next_iteration == 1 else "I’ve updated your plan as requested."
            )
            action = {
                "type": "save_preview",
                "payload": {"goalPreview": plan, "iteration": next_iteration},
            }
            state = {
                "iteration": next_iteration,
                "step": "plan_generated" if next_iteration == 1 else "plan_iteration",
                "sessionActive": True,
            }

        return {"reply": reply, "action": action, "state": state}


root_agent = SequentialAgent(
    name="GoalPlanningWorkflow",
    description="Three-step workflow: classify approval, generate plan, finalize response.",
    sub_agents=[
        CheckApprovalAgent(_json_responder, strict=_STRICT),
        _plan_agent,
        FinalizeAgent(_json_responder, strict=_STRICT),
    ],
)


__all__ = ["root_agent", "_APP_NAME"]
