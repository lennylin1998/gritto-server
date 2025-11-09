from __future__ import annotations

# from dotenv import load_dotenv
import json
import os
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from google.adk.agents import BaseAgent, SequentialAgent
from google.adk.events import Event, EventActions
from google.genai import types

from .llm import GeminiJsonResponder, GeminiPlanner

# load_dotenv()
_MODEL_NAME = os.getenv("AGENT_LLM_MODEL")
_API_KEY = os.getenv("GOOGLE_API_KEY")
_STRICT = os.getenv("AGENT_STRICT_LLM", "false").lower() in {"1", "true", "yes"}
_APP_NAME = "goal_planning_agent"

_planner = GeminiPlanner(model_name=_MODEL_NAME, api_key=_API_KEY)
_json_responder = GeminiJsonResponder(model_name=_MODEL_NAME, api_key=_API_KEY)


def _text_content(message: str) -> types.Content:
    return types.Content(parts=[types.Part(text=message)])


def _deepcopy_json(value: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return json.loads(json.dumps(value))
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


def _extract_user_message(ctx) -> str:
    content = _get_input_obj(ctx)
    if content is None:
        return ""

    direct_message = getattr(content, "message", None)
    if isinstance(direct_message, str) and direct_message.strip():
        return direct_message.strip()

    text_attr = getattr(content, "text", None)
    if isinstance(text_attr, str) and text_attr.strip():
        return text_attr.strip()

    for part in _get_parts(ctx):
        text_value = _part_text(part)
        if text_value and text_value.strip():
            return text_value.strip()
    return ""


def _extract_context(ctx) -> Dict[str, Any]:
    parts = _get_parts(ctx)

    def _call_args(name: str) -> Dict[str, Any]:
        for part in parts:
            fn = _get_function_call(part)
            if not fn:
                continue
            fn_name = _get_attr(fn, "name")
            if fn_name != name:
                continue
            args = _get_attr(fn, "args")
            if isinstance(args, dict):
                return args
        return {}

    goal_preview_ctx = _call_args("goal_preview_context")
    time_ctx = _call_args("time_context")
    task_ctx = _call_args("task_context")

    return {
        "goalPreview": goal_preview_ctx.get("goalPreview"),
        "availableHoursLeft": time_ctx.get("availableHoursLeft"),
        "upcomingTasks": task_ctx.get("upcomingTasks", []),
    }


def _sync_state_with_context(state: Dict[str, Any], context: Dict[str, Any]) -> None:
    if not context:
        return

    state["context"] = _deepcopy_json(context)

    goal_preview = context.get("goalPreview")
    if goal_preview:
        state["proposed_plan"] = _deepcopy_json(goal_preview)
        iteration = goal_preview.get("iteration")
        if isinstance(iteration, int):
            state["iteration"] = iteration


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
        incoming_message = _extract_user_message(ctx)
        state["user_goal_text"] = incoming_message

        context = _extract_context(ctx)
        _sync_state_with_context(state, context)

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
            "user_goal_text": incoming_message,
        }
        if parsed.get("reason"):
            updates["approval_reason"] = parsed["reason"]

        state.update({k: v for k, v in updates.items() if v is not None})

        yield Event(
            author=self.name,
            content=_text_content(json.dumps(parsed)),
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


class PlanAgent(BaseAgent):
    def __init__(self, planner: GeminiPlanner, *, strict: bool = False) -> None:
        super().__init__(
            name="PlanAgent",
            description="Generates or refines the goal preview JSON via Gemini.",
        )
        self._planner = planner
        self._strict = strict

    async def _run_async_impl(self, ctx) -> AsyncGenerator[Event, None]:  # type: ignore[override]
        state = ctx.session.state
        routing = state.get("routing") or "needs_planning"
        state_delta: Dict[str, Any] = {}
        if routing == "finalize_only" and not state.get("proposed_plan"):
            routing = "needs_planning"
            state["routing"] = routing
            state_delta["routing"] = routing

        if routing == "finalize_only":
            yield Event(
                author=self.name,
                content=_text_content("Routing skip: finalize_only"),
            )
            return

        message = state.get("user_goal_text") or ""
        context = state.get("context") or {}
        existing_plan = state.get("proposed_plan")

        plan = await self._planner.generate_plan(
            message=message,
            context=context,
            existing_plan=existing_plan,
            strict=self._strict,
        )
        plan_copy = _deepcopy_json(plan)
        state["proposed_plan"] = plan_copy

        delta = {**state_delta, "proposed_plan": plan_copy}
        yield Event(
            author=self.name,
            content=_text_content(json.dumps(plan_copy)),
            actions=EventActions(state_delta=delta),
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
        reply = final_payload["reply"]
        state_updates = _deepcopy_json(final_payload["state"])

        action_copy = _deepcopy_json(action)
        updates: Dict[str, Any] = {**state_updates, "lastAction": action_copy, "user_goal_text": None}
        updates["final_response"] = _deepcopy_json(final_payload)

        state.update({k: v for k, v in updates.items() if v is not None})
        if updates.get("user_goal_text") is None:
            state.pop("user_goal_text", None)

        yield Event(
            author=self.name,
            content=_text_content(json.dumps(final_payload)),
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
        enriched = json.loads(json.dumps(payload)) if payload else {}
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
        PlanAgent(_planner, strict=_STRICT),
        FinalizeAgent(_json_responder, strict=_STRICT),
    ],
)


__all__ = ["root_agent", "_APP_NAME"]
