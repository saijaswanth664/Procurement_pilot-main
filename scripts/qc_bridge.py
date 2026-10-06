#!/usr/bin/env python3
"""Local QC bridge: Cloudinary + Ollama VLM + QC PDF.

Supabase Edge Functions run in the cloud and cannot reach Ollama on this
laptop (127.0.0.1:11434). Upload-time inference must run here.

  python scripts/qc_bridge.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import cloudinary
import cloudinary.uploader
import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_VLM_MODEL = os.environ.get("OLLAMA_VLM_MODEL", "qwen2.5vl:7b")
QC_PORT = int(os.environ.get("QC_BRIDGE_PORT", "8788"))

cloudinary.config(
    cloud_name=os.environ["CLOUDINARY_CLOUD_NAME"],
    api_key=os.environ["CLOUDINARY_API_KEY"],
    api_secret=os.environ["CLOUDINARY_API_SECRET"],
    secure=True,
)

VLM_PROMPT = """You are a receiving QC inspector for AyuraNest, an Ayurvedic D2C brand (Ashwagandha, Amla, Turmeric, Neem, oils, packaging).
Inspect this inbound batch photo. Reply with ONLY valid JSON (no markdown fences) using this schema:
{
  "product_identification": "string — what you actually see in the photo",
  "visible_defects": ["string", "..."],
  "quality_concerns": ["string", "..."],
  "defect_flag": false,
  "defect_confidence": 0.0,
  "description": "2-4 sentence inspector narrative of THIS photo"
}
Rules:
- visible_defects is empty if the goods look commercially acceptable.
- defect_flag is true only if you see mold, pests/insect fragments, foreign matter, wet/clumped spoilage, severe discoloration, or packaging damage that would fail receiving.
- defect_confidence is a number from 0 to 1 for that flag.
- Do not invent lot numbers or lab assays that are not visible. Describe only what is in the image.
"""

app = FastAPI(title="ProcurementPilot QC bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _sb(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=f"{SUPABASE_URL}",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {token}",
        },
        timeout=60.0,
        trust_env=False,
    )


def _user_and_profile(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    with _sb(token) as c:
        u = c.get("/auth/v1/user")
        if u.status_code != 200:
            raise HTTPException(401, "unauthorized")
        user = u.json()
        p = c.get("/rest/v1/profiles", params={"id": f"eq.{user['id']}", "select": "*"})
        if p.status_code != 200 or not p.json():
            raise HTTPException(403, "profile required")
        return user, p.json()[0]


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        obj = json.loads(text[start : end + 1])
        if isinstance(obj, dict):
            return obj
    raise ValueError("VLM did not return JSON")


def parse_vlm(raw: str) -> dict[str, Any]:
    try:
        obj = extract_json(raw)
    except (ValueError, json.JSONDecodeError):
        lowered = raw.lower()
        flagged = any(w in lowered for w in ("mold", "mould", "insect", "pest", "contaminat"))
        return {
            "product_identification": "unparsed",
            "visible_defects": [],
            "quality_concerns": [],
            "defect_flag": flagged,
            "defect_confidence": 0.55 if flagged else 0.4,
            "description": raw.strip()[:4000],
            "raw": raw,
        }
    flag = bool(obj.get("defect_flag"))
    try:
        conf = float(obj.get("defect_confidence") if obj.get("defect_confidence") is not None else 0)
    except (TypeError, ValueError):
        conf = 0.0
    conf = min(1.0, max(0.0, conf))
    defects = obj.get("visible_defects") or []
    if isinstance(defects, str):
        defects = [defects] if defects else []
    concerns = obj.get("quality_concerns") or []
    if isinstance(concerns, str):
        concerns = [concerns] if concerns else []
    desc = str(obj.get("description") or "").strip()
    ident = str(obj.get("product_identification") or "").strip()
    narrative = desc if desc else raw.strip()[:4000]
    if ident:
        narrative = f"{ident}\n\n{narrative}".strip()
    if defects:
        narrative += "\n\nVisible defects: " + "; ".join(str(x) for x in defects)
    if concerns:
        narrative += "\n\nQuality concerns: " + "; ".join(str(x) for x in concerns)
    return {
        "product_identification": ident or "see description",
        "visible_defects": [str(x) for x in defects],
        "quality_concerns": [str(x) for x in concerns],
        "defect_flag": flag,
        "defect_confidence": conf,
        "description": narrative[:8000],
        "raw": raw,
    }


def call_ollama(image_bytes: bytes) -> str:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": OLLAMA_VLM_MODEL,
        "stream": False,
        "format": "json",
        "messages": [
            {
                "role": "user",
                "content": VLM_PROMPT,
                "images": [b64],
            }
        ],
    }
    with httpx.Client(timeout=180.0, trust_env=False) as c:
        r = c.post(f"{OLLAMA_HOST}/api/chat", json=payload)
        if r.status_code != 200:
            raise HTTPException(502, f"Ollama {r.status_code}: {r.text[:400]}")
        data = r.json()
    return str(data.get("message", {}).get("content") or "")


def build_pdf(
    *,
    batch_id: int,
    supplier_name: str,
    sku: str,
    inspected_at: str,
    parsed: dict[str, Any],
    photo_path: str,
) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
        title=f"AyuraNest QC report · batch {batch_id}",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "QcTitle",
        parent=styles["Heading1"],
        fontName="Times-Bold",
        fontSize=16,
        textColor=colors.HexColor("#3d2a12"),
        spaceAfter=4,
    )
    sub = ParagraphStyle(
        "QcSub",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#6b5344"),
        spaceAfter=12,
    )
    body = ParagraphStyle(
        "QcBody",
        parent=styles["Normal"],
        fontName="Times-Roman",
        fontSize=10,
        leading=14,
        alignment=TA_LEFT,
    )
    label = ParagraphStyle(
        "QcLabel",
        parent=styles["Normal"],
        fontName="Times-Bold",
        fontSize=9,
        textColor=colors.HexColor("#7a4a12"),
        spaceBefore=10,
        spaceAfter=4,
    )
    story: list[Any] = []
    story.append(Paragraph("AyuraNest · Incoming material QC report", title))
    story.append(
        Paragraph(
            "Forward this file to ops / quality. Assessment is from on-device VLM "
            f"({OLLAMA_VLM_MODEL}) on the attached photo — not a lab certificate of analysis.",
            sub,
        )
    )
    verdict = "FAIL — defect flagged" if parsed["defect_flag"] else "PASS — no receiving defect flagged"
    meta = [
        ["Batch ID", str(batch_id), "SKU", sku],
        ["Supplier", supplier_name, "Inspected", inspected_at],
        ["Defect flag", "YES" if parsed["defect_flag"] else "NO", "Confidence", f"{parsed['defect_confidence']:.2f}"],
        ["Verdict", verdict, "Model", OLLAMA_VLM_MODEL],
    ]
    tbl = Table(meta, colWidths=[1.15 * inch, 2.35 * inch, 1.15 * inch, 2.35 * inch])
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f4e6d4")),
                ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f4e6d4")),
                ("FONTNAME", (0, 0), (0, -1), "Times-Bold"),
                ("FONTNAME", (2, 0), (2, -1), "Times-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c4a574")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(tbl)
    story.append(Paragraph("Batch photo", label))
    try:
        img = Image(photo_path)
        max_w = 5.8 * inch
        scale = max_w / float(img.imageWidth)
        img.drawWidth = max_w
        img.drawHeight = float(img.imageHeight) * scale
        story.append(img)
    except Exception:
        story.append(Paragraph("Photo could not be embedded.", body))
    story.append(Paragraph("Product identification", label))
    story.append(Paragraph(escape(parsed["product_identification"] or "—").replace("\n", "<br/>"), body))
    story.append(Paragraph("Inspector description", label))
    story.append(Paragraph(escape(parsed["description"] or "—").replace("\n", "<br/>"), body))
    story.append(Paragraph("Defect assessment", label))
    defects = parsed.get("visible_defects") or []
    story.append(
        Paragraph(
            "None recorded." if not defects else "<br/>".join(f"• {escape(str(d))}" for d in defects),
            body,
        )
    )
    story.append(Paragraph("Quality concerns", label))
    concerns = parsed.get("quality_concerns") or []
    story.append(
        Paragraph(
            "None recorded." if not concerns else "<br/>".join(f"• {escape(str(c))}" for c in concerns),
            body,
        )
    )
    story.append(Spacer(1, 16))
    story.append(
        Paragraph(
            "Not a substitute for wet-lab COA. File under incoming inspection; "
            "escalate FAIL lots before they enter production.",
            sub,
        )
    )
    doc.build(story)
    return buf.getvalue()


@app.get("/health")
def health() -> dict[str, Any]:
    ollama_ok = False
    models: list[str] = []
    try:
        r = httpx.get(f"{OLLAMA_HOST}/api/tags", timeout=3.0, trust_env=False)
        if r.status_code == 200:
            models = [m.get("name", "") for m in r.json().get("models", [])]
            ollama_ok = OLLAMA_VLM_MODEL in models or any(OLLAMA_VLM_MODEL.split(":")[0] in m for m in models)
    except httpx.HTTPError:
        ollama_ok = False
    return {
        "ok": ollama_ok and bool(os.environ.get("CLOUDINARY_API_SECRET")),
        "model": OLLAMA_VLM_MODEL,
        "ollama_reachable": ollama_ok,
        "models": models,
        "cloudinary_cloud": os.environ.get("CLOUDINARY_CLOUD_NAME"),
        "edge_functions_note": (
            "Supabase Edge Functions cannot call Ollama on this machine. "
            "QC inference runs only through this local bridge (scripts/qc_bridge.py)."
        ),
    }


@app.post("/inspect")
async def inspect(
    photo: UploadFile = File(...),
    supplier_id: int = Form(...),
    order_id: int | None = Form(None),
    authorization: str = Header(...),
) -> dict[str, Any]:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "missing bearer token")
    user, profile = _user_and_profile(token)
    role = profile.get("role")
    if role not in ("business_owner", "supplier"):
        raise HTTPException(403, "role not allowed")
    if role == "supplier" and int(profile.get("supplier_id") or 0) != int(supplier_id):
        raise HTTPException(403, "supplier_id must match your profile")

    raw = await photo.read()
    if len(raw) < 32:
        raise HTTPException(400, "empty photo")
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(400, "photo too large")

    with _sb(token) as c:
        sr = c.get("/rest/v1/suppliers", params={"id": f"eq.{supplier_id}", "select": "id,name"})
        if sr.status_code != 200 or not sr.json():
            raise HTTPException(404, "unknown supplier_id")
        supplier_name = sr.json()[0]["name"]

        oid = order_id
        sku = "QC-INTAKE"
        if oid:
            orow = c.get(
                "/rest/v1/orders",
                params={"id": f"eq.{oid}", "select": "id,supplier_id,sku,business_id"},
            )
            if orow.status_code != 200 or not orow.json():
                raise HTTPException(404, "unknown order_id")
            o = orow.json()[0]
            if int(o["supplier_id"]) != int(supplier_id):
                raise HTTPException(400, "order is not for this supplier")
            sku = o["sku"]
        else:
            created = c.post(
                "/rest/v1/orders",
                headers={"Prefer": "return=representation", "Content-Type": "application/json"},
                json={
                    "business_id": user["id"],
                    "supplier_id": supplier_id,
                    "sku": "QC-INTAKE",
                    "qty_ordered": 0,
                    "qty_allocated": 0,
                    "status": "qc_intake",
                },
            )
            if created.status_code not in (200, 201):
                raise HTTPException(400, f"could not create order: {created.text[:300]}")
            oid = created.json()[0]["id"]
            sku = "QC-INTAKE"

    vlm_raw = call_ollama(raw)
    parsed = parse_vlm(vlm_raw)

    suffix = Path(photo.filename or "batch.jpg").suffix or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        up_photo = cloudinary.uploader.upload(
            tmp_path,
            folder="ayuranest/qc/photos",
            resource_type="image",
        )
        photo_url = up_photo["secure_url"]
        photo_pid = up_photo["public_id"]

        with _sb(token) as c:
            ins = c.post(
                "/rest/v1/batches",
                headers={"Prefer": "return=representation", "Content-Type": "application/json"},
                json={
                    "order_id": oid,
                    "supplier_id": supplier_id,
                    "photo_url": photo_url,
                    "photo_public_id": photo_pid,
                    "vlm_description": parsed["description"],
                    "defect_flag": parsed["defect_flag"],
                    "defect_confidence": parsed["defect_confidence"],
                },
            )
            if ins.status_code not in (200, 201):
                raise HTTPException(400, f"batch insert failed: {ins.text[:400]}")
            batch = ins.json()[0]
            batch_id = int(batch["id"])

        inspected_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        pdf_bytes = build_pdf(
            batch_id=batch_id,
            supplier_name=supplier_name,
            sku=sku,
            inspected_at=inspected_at,
            parsed=parsed,
            photo_path=tmp_path,
        )
        up_pdf = cloudinary.uploader.upload(
            io.BytesIO(pdf_bytes),
            folder="ayuranest/qc/reports",
            resource_type="raw",
            public_id=f"batch-{batch_id}",
            format="pdf",
        )
        pdf_url = up_pdf["secure_url"]
        pdf_pid = up_pdf["public_id"]

        with _sb(token) as c:
            upd = c.patch(
                "/rest/v1/batches",
                params={"id": f"eq.{batch_id}"},
                headers={"Prefer": "return=representation", "Content-Type": "application/json"},
                json={
                    "reported_pdf_url": pdf_url,
                    "reported_pdf_public_id": pdf_pid,
                },
            )
            if upd.status_code not in (200, 204):
                raise HTTPException(400, f"pdf url update failed: {upd.text[:400]}")
            if upd.content:
                batch = upd.json()[0]
            else:
                batch["reported_pdf_url"] = pdf_url
                batch["reported_pdf_public_id"] = pdf_pid

            flag = parsed["defect_flag"]
            c.post(
                "/rest/v1/decisions",
                headers={"Content-Type": "application/json"},
                json={
                    "related_entity_type": "batch",
                    "related_entity_id": batch_id,
                    "decision_text": (
                        f"QC {'FAIL' if flag else 'PASS'} batch #{batch_id} "
                        f"{supplier_name} sku={sku} (VLM {OLLAMA_VLM_MODEL}, "
                        f"confidence={parsed['defect_confidence']:.2f})."
                    ),
                    "reasoning": parsed["description"][:4000],
                    "made_by": "agent",
                },
            )
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return {
        "batch": batch,
        "vlm": {
            "model": OLLAMA_VLM_MODEL,
            "raw": parsed["raw"],
            "parsed": {k: parsed[k] for k in ("product_identification", "visible_defects", "quality_concerns", "defect_flag", "defect_confidence", "description")},
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=QC_PORT, reload=False)
