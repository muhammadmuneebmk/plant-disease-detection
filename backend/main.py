import base64
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

FALLBACK_PROMPT = (
    "You are an expert plant pathologist. A specialized plant-disease model looked at this leaf "
    "photo and gave a low-confidence guess: crop '{crop}', possible issue '{disease}' "
    "({probability:.0%} confidence). Look at the image yourself and give a short second opinion: "
    "1) your best guess at the disease or issue, 2) the visual symptoms that support it, "
    "3) a brief treatment suggestion. Keep it under 120 words, plain text, no markdown."
)

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


def call_gemini(image_b64: str, mime_type: str, prompt: str) -> str:
    response = requests.post(
        GEMINI_URL,
        params={"key": GEMINI_API_KEY},
        json={
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                    ]
                }
            ]
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return data["candidates"][0]["content"]["parts"][0]["text"].strip()


def call_openai(image_b64: str, mime_type: str, prompt: str) -> str:
    response = requests.post(
        OPENAI_URL,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": OPENAI_MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{image_b64}"}},
                    ],
                }
            ],
            "max_tokens": 300,
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"].strip()


def get_fallback_diagnosis(image_b64: str, mime_type: str, crop: str, disease: str, probability: float):
    provider = FALLBACK_PROVIDER
    prompt = FALLBACK_PROMPT.format(crop=crop or "unknown", disease=disease or "unknown", probability=probability)

    if provider == "gemini" and GEMINI_API_KEY:
        text = call_gemini(image_b64, mime_type, prompt)
    elif provider == "openai" and OPENAI_API_KEY:
        text = call_openai(image_b64, mime_type, prompt)
    else:
        return None

    return {"provider": provider, "analysis": text}


async def encode_images(files: list[UploadFile]) -> tuple[list[str], str]:
    images_b64 = []
    mime_type = "image/jpeg"
    for i, f in enumerate(files):
        content = await f.read()
        images_b64.append(base64.b64encode(content).decode("utf-8"))
        if i == 0:
            mime_type = f.content_type or "image/jpeg"
    return images_b64, mime_type


@app.post("/predict")
async def predict(files: list[UploadFile] = File(...)):
    if not KINDWISE_API_KEY:
        raise HTTPException(status_code=500, detail="KINDWISE_API_KEY is not set on the server")

    images_b64, mime_type = await encode_images(files)
    image_b64 = images_b64[0]

    try:
        response = requests.post(
            KINDWISE_URL,
            params={"details": DISEASE_DETAILS, "language": "en"},
            headers={"Api-Key": KINDWISE_API_KEY, "Content-Type": "application/json"},
            json={"images": images_b64, "health": "all"},
            timeout=30,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Kindwise API request failed: {exc}") from exc

    data = response.json()
    result = data.get("result", {})

    crop_suggestions = result.get("classification", {}).get("suggestions", [])
    disease_suggestions = result.get("disease", {}).get("suggestions", [])

    top_crop = crop_suggestions[0] if crop_suggestions else None
    top_disease = disease_suggestions[0] if disease_suggestions else None

    is_healthy = result.get("is_healthy", {}).get("binary")
    disease_probability = top_disease.get("probability") if top_disease else None

    fallback = None
    if disease_probability is not None and disease_probability < CONFIDENCE_THRESHOLD and not is_healthy:
        try:
            fallback = get_fallback_diagnosis(
                image_b64,
                mime_type,
                top_crop.get("name") if top_crop else None,
                top_disease.get("name") if top_disease else None,
                disease_probability,
            )
        except requests.RequestException:
            fallback = None

    return {
        "crop": {
            "name": top_crop.get("name") if top_crop else None,
            "probability": top_crop.get("probability") if top_crop else None,
        },
        "disease": None
        if not top_disease
        else {
            "name": top_disease.get("name"),
            "probability": top_disease.get("probability"),
            "is_healthy": is_healthy,
            "details": top_disease.get("details", {}),
        },
        "fallback": fallback,
    }


@app.post("/identify")
async def identify(files: list[UploadFile] = File(...)):
    if not KINDWISE_API_KEY:
        raise HTTPException(status_code=500, detail="KINDWISE_API_KEY is not set on the server")

    images_b64, _ = await encode_images(files)

    try:
        response = requests.post(
            KINDWISE_URL,
            params={"details": FINDER_DETAILS, "language": "en"},
            headers={"Api-Key": KINDWISE_API_KEY, "Content-Type": "application/json"},
            json={"images": images_b64},
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
