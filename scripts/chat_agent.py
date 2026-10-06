#!/usr/bin/env python3
"""
Chat Agent Background Worker

Polls the Supabase `messages` table for new pending messages from suppliers,
runs them through the local Ollama LLM to determine if they need escalation,
and updates the message along with logging a decision if escalated.

Requires SUPABASE_SERVICE_ROLE_KEY in .env
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "qwen2.5vl:7b")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

PROMPT = """You are an AI Procurement Assistant. 
Analyze the following message from a supplier.
Determine if the message requires urgent escalation to the business owner dashboard. 
Escalations should include situations like: delays, missing capacity, natural disasters, broken equipment, failed quality checks, or significant price changes.
Routine updates, pleasantries, or non-urgent questions should not be escalated.

Respond ONLY with valid JSON using the following schema:
{
  "escalate": boolean,
  "reasoning": "string - explain why this should or should not be escalated"
}

Supplier message:
"{body}"
"""

def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("No JSON found")

def classify_message(body: str) -> dict[str, Any]:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "format": "json",
        "messages": [
            {
                "role": "user",
                "content": PROMPT.format(body=body),
            }
        ],
    }
    with httpx.Client(timeout=30.0, trust_env=False) as c:
        r = c.post(f"{OLLAMA_HOST}/api/chat", json=payload)
        r.raise_for_status()
        data = r.json()
        content = data.get("message", {}).get("content", "")
        return extract_json(content)

def poll_and_process():
    print(f"[{datetime.now().isoformat()}] Polling for pending messages...")
    try:
        # Fetch pending messages from suppliers
        res = (
            supabase.table("messages")
            .select("*")
            .eq("classification_status", "pending")
            .eq("sender_role", "supplier")
            .execute()
        )
        messages = res.data
        if not messages:
            return

        for msg in messages:
            msg_id = msg["id"]
            body = msg.get("body", "")
            print(f"Processing message {msg_id}: '{body[:50]}...'")

            if not body.strip():
                # Empty body, just mark reviewed
                supabase.table("messages").update({"classification_status": "reviewed"}).eq("id", msg_id).execute()
                continue

            try:
                result = classify_message(body)
                escalate = bool(result.get("escalate", False))
                reasoning = result.get("reasoning", "No reasoning provided.")
            except Exception as e:
                print(f"Error classifying {msg_id}: {e}")
                continue

            print(f"Result for {msg_id}: escalate={escalate}, reasoning={reasoning}")

            # Update the message
            supabase.table("messages").update({
                "classification_status": "reviewed",
                "flagged_for_dashboard": escalate,
            }).eq("id", msg_id).execute()

            # If escalated, log a decision
            if escalate:
                decision_text = f"Escalated supplier message #{msg_id} to dashboard."
                supabase.table("decisions").insert({
                    "related_entity_type": "message",
                    "related_entity_id": msg_id,
                    "decision_text": decision_text,
                    "reasoning": reasoning,
                    "made_by": "agent"
                }).execute()
                print(f"Logged decision for message {msg_id}")

    except Exception as e:
        print(f"Polling error: {e}")

if __name__ == "__main__":
    print(f"Starting Chat Agent. Model: {OLLAMA_MODEL}, DB: {SUPABASE_URL}")
    while True:
        poll_and_process()
        time.sleep(5)
