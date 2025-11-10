FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN adduser --disabled-password --gecos "" appuser && \
    chown -R appuser:appuser /app

COPY goal_planning_agent ./goal_planning_agent
COPY main.py ./main.py

USER appuser
ENV PATH="/home/appuser/.local/bin:$PATH"

ENV AGENT_LLM_MODEL="gemini-2.0-flash" \
    AGENT_STRICT_LLM="true"

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
