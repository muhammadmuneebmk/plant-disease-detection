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


KINDWISE_API_KEYS = [k for k in (_clean_env("KINDWISE_API_KEY"), _clean_env("KINDWISE_API_KEY_BACKUP")) if k]
KINDWISE_URL = "https://plant.id/api/v3/identification"
# plant.id returns 429 when a key is out of credits and 401 when it's invalid.
KEY_EXHAUSTED_STATUSES = {401, 429}
DISEASE_DETAILS = "description,treatment,common_names,url,classification"
FINDER_DETAILS = (
    "common_names,url,description,watering,best_watering,best_light_condition,"
    "best_soil_type,common_uses,toxicity,edible_parts,synonyms,image"
)

FALLBACK_PROVIDER = os.getenv("FALLBACK_PROVIDER", "gemini").lower()
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.5"))

GEMINI_API_KEY = _clean_env("GEMINI_API_KEY")
# The free tier allows only ~20 requests/day per model, so fall back to a second model
# (which has its own quota) when the first one runs out.
GEMINI_MODELS = [
    m
    for m in (_clean_env("GEMINI_MODEL") or "gemini-3.5-flash", _clean_env("GEMINI_BACKUP_MODEL") or "gemini-3.5-flash-lite")
    if m
]
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

OPENAI_API_KEY = _clean_env("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

MIN_PHOTOS = 3
MAX_PHOTOS = 5  # plant.id accepts up to 5 images per identification
# plant.id scores all photos together, so healthy-looking photos can outweigh one sick leaf.
# Only trust "healthy" when it's clearly confident; anything weaker gets a per-photo check.
HEALTHY_CONFIDENCE = 0.8
# Reduces run-to-run variation on top of temperature 0 (not a guarantee for thinking models).
LLM_SEED = 7

FALLBACK_PROMPT = (
    "You are a plant pathologist. These {count} photos all show the same plant{crop_hint}. "
    "A specialist plant-health model could not give a confident result. It scores all photos "
    "together, so a problem visible in only one photo can be missed. Examine every photo and give "
    "your own assessment.\n"
    "Rules:\n"
    "- Check each photo separately. If any photo shows symptoms, report them even if the other "
    "photos look healthy.\n"
    "- Only name a disease, pest, or deficiency if you can see symptoms in the photos that support it.\n"
    "- If the photos are too dark, blurry, or far away, or show nothing clearly abnormal, set "
    "diagnosis to \"Uncertain\" and use symptoms to say what photo would help.\n"
    "- Never describe symptoms you cannot actually see.\n"
    "Respond in JSON with keys: diagnosis (short name; if it has a scientific name, write it as "
    "\"Scientific name (everyday name a farmer would use)\", e.g. \"Ramularia areola (Grey mildew)\"; "
    "or \"Uncertain\"), confidence "
    "(\"low\", \"medium\", or \"high\"), symptoms (what you see, max 2 sentences), treatment "
    "(brief practical advice, max 2 sentences, or an empty string if diagnosis is \"Uncertain\"), "
    "affected_photos (list of the photo numbers that show the symptoms, empty if none)."
)

FALLBACK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "diagnosis": {"type": "STRING"},
        "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
        "symptoms": {"type": "STRING"},
        "treatment": {"type": "STRING"},
        "affected_photos": {"type": "ARRAY", "items": {"type": "INTEGER"}},
    },
    "required": ["diagnosis", "confidence", "symptoms", "treatment", "affected_photos"],
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
    parts = [{"text": prompt}]
    for i, (b64, mime) in enumerate(images, start=1):
        parts += [{"text": f"Photo {i}:"}, {"inline_data": {"mime_type": mime, "data": b64}}]
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "seed": LLM_SEED,
            "responseMimeType": "application/json",
            "responseSchema": FALLBACK_SCHEMA,
        },
    }
    for i, model in enumerate(GEMINI_MODELS):
        response = requests.post(GEMINI_URL.format(model=model), params={"key": GEMINI_API_KEY}, json=body, timeout=90)
        if response.status_code == 429 and i < len(GEMINI_MODELS) - 1:
            continue
        break
    response.raise_for_status()
    return json.loads(response.json()["candidates"][0]["content"]["parts"][0]["text"])


def call_openai(images: list[tuple[str, str]], prompt: str) -> dict:
    content = [{"type": "text", "text": prompt}]
    for i, (b64, mime) in enumerate(images, start=1):
        content += [
            {"type": "text", "text": f"Photo {i}:"},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ]
    response = requests.post(
        OPENAI_URL,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": OPENAI_MODEL,
            "messages": [{"role": "user", "content": content}],
            "temperature": 0,
            "seed": LLM_SEED,
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


def first_common_name(suggestion: dict) -> str | None:
    return ((suggestion.get("details") or {}).get("common_names") or [None])[0]


def require_photos(files: list[UploadFile]) -> None:
    if not MIN_PHOTOS <= len(files) <= MAX_PHOTOS:
        raise HTTPException(
            status_code=400,
            detail=f"Please upload {MIN_PHOTOS} to {MAX_PHOTOS} photos of the same plant (you sent {len(files)}).",
        )


def call_kindwise(params: dict, body: dict) -> dict:
    if not KINDWISE_API_KEYS:
        raise HTTPException(status_code=500, detail="KINDWISE_API_KEY is not set on the server")

    for i, key in enumerate(KINDWISE_API_KEYS):
        try:
            response = requests.post(
                KINDWISE_URL,
                params=params,
                headers={"Api-Key": key, "Content-Type": "application/json"},
                json=body,
                timeout=30,
            )
            if response.status_code in KEY_EXHAUSTED_STATUSES and i < len(KINDWISE_API_KEYS) - 1:
                continue
            response.raise_for_status()
        except requests.RequestException as exc:
            raise HTTPException(status_code=502, detail=f"Kindwise API request failed: {exc}") from exc
        return response.json().get("result", {})


@app.post("/predict")
async def predict(files: list[UploadFile] = File(...)):
    require_photos(files)
    images = await read_images(files)
    result = call_kindwise(
        {"details": DISEASE_DETAILS, "language": "en"},
        {"images": [b64 for b64, _ in images], "health": "all"},
    )

    crop_suggestions = result.get("classification", {}).get("suggestions", [])
    disease_suggestions = result.get("disease", {}).get("suggestions", [])
    health = result.get("is_healthy") or {}

    top_crop = crop_suggestions[0] if crop_suggestions else {}
    top_disease = disease_suggestions[0] if disease_suggestions else None

    # Low-probability disease suggestions are near-noise and reorder between runs,
    # so only name a disease when plant.id is actually confident in it.
    if health.get("binary") and (health.get("probability") or 0) >= HEALTHY_CONFIDENCE:
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
        "crop": {
            "name": top_crop.get("name"),
            "common_name": first_common_name(top_crop),
            "probability": top_crop.get("probability"),
        },
        "disease": {
            "name": top_disease.get("name"),
            "common_name": first_common_name(top_disease),
            "probability": top_disease.get("probability"),
            "details": top_disease.get("details", {}),
        }
        if verdict == "diseased"
        else None,
        "candidates": [
            {"name": s.get("name"), "common_name": first_common_name(s), "probability": s.get("probability")}
            for s in disease_suggestions[:3]
        ]
        if verdict == "uncertain"
        else [],
        "fallback": fallback,
    }


@app.post("/identify")
async def identify(files: list[UploadFile] = File(...)):
    require_photos(files)
    images = await read_images(files)
    result = call_kindwise({"details": FINDER_DETAILS, "language": "en"}, {"images": [b64 for b64, _ in images]})
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
