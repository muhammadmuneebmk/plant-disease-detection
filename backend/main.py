import base64
import json
import os

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

def _clean_env(name: str) -> str | None:
    value = os.getenv(name)
    return value.strip() if value else value


KINDWISE_API_KEY = _clean_env("KINDWISE_API_KEY")
KINDWISE_URL = "https://plant.id/api/v3/identification"
DISEASE_DETAILS = "description,treatment,common_names,url,classification"
FINDER_DETAILS = (
    "common_names,url,description,watering,best_watering,best_light_condition,"
    "best_soil_type,common_uses,toxicity,edible_parts,synonyms,image"
)

FALLBACK_PROVIDER = os.getenv("FALLBACK_PROVIDER", "gemini").lower()
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.5"))

GEMINI_API_KEY = _clean_env("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

OPENAI_API_KEY = _clean_env("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

REQUIRED_PHOTOS = 3

FALLBACK_PROMPT = (
    "You are a plant pathologist. These {count} photos all show the same plant{crop_hint}. "
    "A specialist plant-health model found signs of a problem but could not identify the cause "
    "with confidence. Examine every photo and give your own assessment.\n"
    "Rules:\n"
    "- Only name a disease, pest, or deficiency if you can see symptoms in the photos that support it.\n"
    "- If the photos are too dark, blurry, or far away, or show nothing clearly abnormal, set "
    "diagnosis to \"Uncertain\" and use symptoms to say what photo would help.\n"
    "- Never describe symptoms you cannot actually see.\n"
    "Respond in JSON with keys: diagnosis (short name, or \"Uncertain\"), confidence "
    "(\"low\", \"medium\", or \"high\"), symptoms (what you see, max 2 sentences), treatment "
    "(brief practical advice, max 2 sentences, or an empty string if diagnosis is \"Uncertain\")."
)

FALLBACK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "diagnosis": {"type": "STRING"},
        "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
        "symptoms": {"type": "STRING"},
        "treatment": {"type": "STRING"},
    },
    "required": ["diagnosis", "confidence", "symptoms", "treatment"],
}

app = FastAPI(title="Plant Disease Detection API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health_check():
    return {"status": "ok"}


def call_gemini(images: list[tuple[str, str]], prompt: str) -> dict:
    parts = [{"text": prompt}] + [{"inline_data": {"mime_type": mime, "data": b64}} for b64, mime in images]
    response = requests.post(
        GEMINI_URL,
        params={"key": GEMINI_API_KEY},
        json={
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseSchema": FALLBACK_SCHEMA,
            },
        },
        timeout=60,
    )
    response.raise_for_status()
    return json.loads(response.json()["candidates"][0]["content"]["parts"][0]["text"])


def call_openai(images: list[tuple[str, str]], prompt: str) -> dict:
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}} for b64, mime in images
    ]
    response = requests.post(
        OPENAI_URL,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": OPENAI_MODEL,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "max_tokens": 400,
        },
        timeout=60,
    )
    response.raise_for_status()
    return json.loads(response.json()["choices"][0]["message"]["content"])


def get_fallback_diagnosis(images: list[tuple[str, str]], crop: str | None, crop_probability: float | None):
    confident_crop = crop and crop_probability is not None and crop_probability >= CONFIDENCE_THRESHOLD
    prompt = FALLBACK_PROMPT.format(count=len(images), crop_hint=f" (most likely {crop})" if confident_crop else "")

    if FALLBACK_PROVIDER == "gemini" and GEMINI_API_KEY:
        result = call_gemini(images, prompt)
    elif FALLBACK_PROVIDER == "openai" and OPENAI_API_KEY:
        result = call_openai(images, prompt)
    else:
        return None

    return {"provider": FALLBACK_PROVIDER, **result}


async def read_images(files: list[UploadFile]) -> list[tuple[str, str]]:
    return [(base64.b64encode(await f.read()).decode("utf-8"), f.content_type or "image/jpeg") for f in files]


@app.post("/predict")
async def predict(files: list[UploadFile] = File(...)):
    if not KINDWISE_API_KEY:
        raise HTTPException(status_code=500, detail="KINDWISE_API_KEY is not set on the server")

    if len(files) != REQUIRED_PHOTOS:
        raise HTTPException(
            status_code=400,
            detail=f"Please upload exactly {REQUIRED_PHOTOS} photos of the same plant (you sent {len(files)}).",
        )

    images = await read_images(files)

    try:
        response = requests.post(
            KINDWISE_URL,
            params={"details": DISEASE_DETAILS, "language": "en"},
            headers={"Api-Key": KINDWISE_API_KEY, "Content-Type": "application/json"},
            json={"images": [b64 for b64, _ in images], "health": "all"},
            timeout=30,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Kindwise API request failed: {exc}") from exc

    result = response.json().get("result", {})

    crop_suggestions = result.get("classification", {}).get("suggestions", [])
    disease_suggestions = result.get("disease", {}).get("suggestions", [])
    health = result.get("is_healthy") or {}

    top_crop = crop_suggestions[0] if crop_suggestions else {}
    top_disease = disease_suggestions[0] if disease_suggestions else None

    # Low-probability disease suggestions are near-noise and reorder between runs,
    # so only name a disease when plant.id is actually confident in it.
    if health.get("binary"):
        verdict = "healthy"
    elif top_disease and top_disease.get("probability", 0) >= CONFIDENCE_THRESHOLD:
        verdict = "diseased"
    else:
        verdict = "uncertain"

    fallback = None
    if verdict == "uncertain":
        try:
            fallback = get_fallback_diagnosis(images, top_crop.get("name"), top_crop.get("probability"))
        except (requests.RequestException, KeyError, IndexError, ValueError):
            fallback = None

    return {
        "verdict": verdict,
        "health_probability": health.get("probability"),
        "crop": {"name": top_crop.get("name"), "probability": top_crop.get("probability")},
        "disease": {
            "name": top_disease.get("name"),
            "probability": top_disease.get("probability"),
            "details": top_disease.get("details", {}),
        }
        if verdict == "diseased"
        else None,
        "candidates": [
            {"name": s.get("name"), "probability": s.get("probability")} for s in disease_suggestions[:3]
        ]
        if verdict == "uncertain"
        else [],
        "fallback": fallback,
    }


@app.post("/identify")
async def identify(files: list[UploadFile] = File(...)):
    if not KINDWISE_API_KEY:
        raise HTTPException(status_code=500, detail="KINDWISE_API_KEY is not set on the server")

    images = await read_images(files)

    try:
        response = requests.post(
            KINDWISE_URL,
            params={"details": FINDER_DETAILS, "language": "en"},
            headers={"Api-Key": KINDWISE_API_KEY, "Content-Type": "application/json"},
            json={"images": [b64 for b64, _ in images]},
            timeout=30,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Kindwise API request failed: {exc}") from exc

    data = response.json()
    result = data.get("result", {})
    suggestions = result.get("classification", {}).get("suggestions", [])
    top = suggestions[0] if suggestions else None

    if not top:
        return {"plant": None}

    return {
        "plant": {
            "name": top.get("name"),
            "probability": top.get("probability"),
            "details": top.get("details", {}),
        }
    }
