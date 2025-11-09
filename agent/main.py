from __future__ import annotations

import os
from pathlib import Path
from typing import List

# import logging

import uvicorn
from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app

# # Configure logging
# logging.basicConfig(level=logging.INFO)
# logger = logging.getLogger(__name__)

BASE_DIR = os.path.join(os.path.dirname(__file__), "goal_planning_agent")
SESSION_SERVICE_URI = os.getenv("SESSION_SERVICE_URI", "sqlite:///./sessions.db")
ALLOWED_ORIGINS_RAW = os.getenv(
    "ALLOW_ORIGINS",
    "http://localhost,http://localhost:8080,*",
)
SERVE_WEB_INTERFACE = os.getenv("SERVE_WEB_INTERFACE", "true").lower() in {"1", "true", "yes"}
ENABLE_A2A = os.getenv("ENABLE_A2A", "false").lower() in {"1", "true", "yes"}


def _parse_origins(raw: str) -> List[str]:
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app: FastAPI = get_fast_api_app(
    agents_dir=str(BASE_DIR),
    session_service_uri=SESSION_SERVICE_URI,
    allow_origins=_parse_origins(ALLOWED_ORIGINS_RAW),
    web=SERVE_WEB_INTERFACE,
    a2a=ENABLE_A2A,
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
