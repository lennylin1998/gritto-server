from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Dict, Optional

try:
    import google.genai as genai  # type: ignore[attr-defined]
except Exception:  # pragma: no cover - local dev without google-genai
    genai = None  # type: ignore


SYSTEM_PROMPT = (
    "You are Gritto's gaol planning specialist. Generate structured JSON that matches the GoalPreview schema.\n"
    "The JSON must contain keys: goal, milestones (list), and optional id/summary.\n"
    "- goal: object with title, description (optional), category (optional).\n"
    "- milestones: list of objects with title, tasks (list).\n"
    "- tasks: list of objects with title, description (optional).\n"
    "Return only JSON. No markdown."
)


class PlanGenerationError(RuntimeError):
    """Raised when the LLM response cannot be parsed into a plan."""


def _init_model(model_name: Optional[str], api_key: Optional[str]):
    if not genai or not api_key:
        return None
    genai.configure(api_key=api_key)
    try:
        return genai.GenerativeModel(model_name or "gemini-1.5-pro-latest")
    except Exception:  # pragma: no cover - defer to fallback
        return None


def _extract_json(raw_text: str) -> Optional[Dict[str, Any]]:
    if not raw_text:
        return None
    match = re.search(r"\{.*\}", raw_text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


class GeminiPlanner:
    """Generates or refines goal plans via Google Gemini."""

    def __init__(self, *, model_name: str | None = None, api_key: str | None = None) -> None:
        self.model_name = model_name or "gemini-1.5-pro-latest"
        self.api_key = api_key
        self._model = _init_model(self.model_name, self.api_key)

    async def generate_plan(
        self,
        *,
        message: str,
        context: Dict[str, Any],
        existing_plan: Optional[Dict[str, Any]] = None,
        strict: bool = False,
    ) -> Dict[str, Any]:
        if not self._model:
            return self._fallback_plan(message, existing_plan)

        prompt = self._build_prompt(message, context, existing_plan)
        try:
            response = await asyncio.to_thread(self._model.generate_content, prompt)
        except Exception as exc:  # pragma: no cover - network path
            if strict:
                raise PlanGenerationError(f"Gemini invocation failed: {exc}") from exc
            return self._fallback_plan(message, existing_plan)

        text = _extract_text(response)
        plan = _extract_json(text)
        if plan is None:
            if strict:
                raise PlanGenerationError("Gemini did not return valid JSON plan.")
            return self._fallback_plan(message, existing_plan)
        return plan

    def _build_prompt(
        self,
        message: str,
        context: Dict[str, Any],
        existing_plan: Optional[Dict[str, Any]],
    ) -> str:
        goals = context.get("existingGoals") or []
        events = context.get("calendarEvents") or []
        existing_json = json.dumps(existing_plan, ensure_ascii=False, indent=2) if existing_plan else "null"

        return (
            f"{SYSTEM_PROMPT}\n"
            f"User message: {message}\n"
            f"Existing plan JSON: {existing_json}\n"
            f"Existing goals: {json.dumps(goals, ensure_ascii=False)}\n"
            f"Calendar events: {json.dumps(events, ensure_ascii=False)}\n"
            "Respond with updated GoalPreview JSON only."
        )

    @staticmethod
    def _fallback_plan(message: str, existing_plan: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        base_plan: Dict[str, Any] = {}
        if isinstance(existing_plan, dict):
            base_plan = json.loads(json.dumps(existing_plan))  # deep copy
        if "goal" not in base_plan:
            base_plan["goal"] = {"title": message.strip() or "Untitled Goal"}
        if "milestones" not in base_plan or not base_plan["milestones"]:
            base_plan["milestones"] = [
                {
                    "title": "Plan Milestone",
                    "tasks": [
                        {"title": "Clarify objective"},
                        {"title": "Outline next steps"},
                    ],
                }
            ]
        return base_plan


def _extract_text(response: Any) -> str:
    """Extracts text from a generative response."""

    if response is None:
        return ""

    text = getattr(response, "text", None)
    if text:
        return text

    candidates = getattr(response, "candidates", None)
    if not candidates:
        return ""

    parts = []
    for candidate in candidates:
        for part in getattr(candidate, "content", {}).get("parts", []):
            if isinstance(part, dict) and part.get("text"):
                parts.append(part["text"])
            elif hasattr(part, "text"):
                parts.append(part.text)  # type: ignore[attr-defined]
    return "".join(parts)


class GeminiJsonResponder:
    """Runs lightweight JSON-only prompts for routing and finalization."""

    def __init__(self, *, model_name: str | None = None, api_key: str | None = None) -> None:
        self.model_name = model_name or "gemini-1.5-pro-latest"
        self.api_key = api_key
        self._model = _init_model(self.model_name, self.api_key)

    async def classify_approval(
        self,
        *,
        message: str,
        state_snapshot: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not self._model:
            return None

        prompt = self._build_check_prompt(message=message, state_snapshot=state_snapshot)
        return await self._invoke_json(prompt)

    async def finalize_response(
        self,
        *,
        state_snapshot: Dict[str, Any],
        plan: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not self._model:
            return None

        prompt = self._build_finalize_prompt(state_snapshot=state_snapshot, plan=plan)
        return await self._invoke_json(prompt)

    async def _invoke_json(self, prompt: str) -> Optional[Dict[str, Any]]:
        try:
            response = await asyncio.to_thread(self._model.generate_content, prompt)
        except Exception:  # pragma: no cover - network path
            return None
        text = _extract_text(response)
        return _extract_json(text)

    def _build_check_prompt(self, *, message: str, state_snapshot: Dict[str, Any]) -> str:
        state_json = json.dumps(state_snapshot, ensure_ascii=False, indent=2)
        return (
            "You are CheckApprovalAgent for the Gritto workflow.\n"
            "Decide if the user approves the current plan or requires more planning.\n"
            "Output STRICT JSON with keys routing, detectedConsent, reason.\n"
            "routing must be 'finalize_only' or 'needs_planning'.\n"
            "detectedConsent is true only when the user clearly approves changes.\n"
            "Example: {\"routing\": \"finalize_only\", \"detectedConsent\": true, \"reason\": \"They said looks good\"}.\n"
            "Session state for context:\n"
            f"{state_json}\n"
            f"Most recent user message: {message}\n"
            "Return JSON only."
        )

    def _build_finalize_prompt(self, *, state_snapshot: Dict[str, Any], plan: Dict[str, Any]) -> str:
        state_json = json.dumps(state_snapshot, ensure_ascii=False, indent=2)
        plan_json = json.dumps(plan or {}, ensure_ascii=False, indent=2)
        return (
            "You are FinalizeAgent for the Gritto GoalPlanning workflow.\n"
            "Produce the final reply, backend action, and next state as strict JSON.\n"
            "Rules:\n"
            "- Always respond with an object containing reply, action, state.\n"
            "- action.type must be one of ['save_preview','finalize_goal','none'].\n"
            "- If routing == 'finalize_only' and a plan exists, finalise with action.type='finalize_goal', state.step='finalized', state.sessionActive=false, iteration stays the same.\n"
            "- Otherwise, action.type='save_preview', increment iteration by 1, state.sessionActive=true, step='plan_generated' when iteration becomes 1 else 'plan_iteration'.\n"
            "- Include plan data inside the payload so the backend can persist it.\n"
            "User/session state:\n"
            f"{state_json}\n"
            "Current GoalPreview proposal:\n"
            f"{plan_json}\n"
            "Return JSON only."
        )


__all__ = [
    "GeminiPlanner",
    "PlanGenerationError",
    "GeminiJsonResponder",
]
