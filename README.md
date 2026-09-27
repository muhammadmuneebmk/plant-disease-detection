# Plant Disease Detection

AI-powered plant disease detection web app — upload leaf photos to identify crop diseases with treatment suggestions, using plant.id with a Gemini/GPT-4o fallback for low-confidence cases.

Upload a photo of a plant leaf and get the crop name + disease diagnosis (with description and treatment), powered by [plant.id](https://plant.id/docs) (Kindwise). When the disease confidence is low, a second AI model (Gemini or GPT-4o) is automatically consulted for a second opinion.

## Stack

- **Backend**: FastAPI (Python) — proxies image uploads to plant.id and returns simplified JSON.
- **Frontend**: Plain HTML/CSS/JS — upload box, preview, and animated result card.
- **Primary AI**: plant.id (Kindwise) — pretrained model for plant species + disease/pest identification.
- **Fallback AI**: Gemini (default) or GPT-4o — only called when plant.id's disease confidence is below a threshold, for a plain-language second opinion.

## 1. Get API keys

1. **plant.id** (required): go to https://plant.id/docs, request an API key, and make sure it's issued for the **plant.id** product (not crop.health — they look similar but are separate keys).
2. **Gemini** (recommended fallback, free tier): get a key at https://aistudio.google.com/apikey.
3. **OpenAI** (optional, only if you want to switch fallback to GPT-4o): get a key at https://platform.openai.com/api-keys (paid, no free tier).

Copy `backend/.env.example` to `backend/.env` and fill in the keys:

```
KINDWISE_API_KEY=your_plant_id_key
FALLBACK_PROVIDER=gemini        # or "openai"
CONFIDENCE_THRESHOLD=0.5        # fallback triggers when disease confidence is below this
GEMINI_API_KEY=your_gemini_key
OPENAI_API_KEY=your_openai_key  # only needed if FALLBACK_PROVIDER=openai
```

To switch the fallback model later, just change `FALLBACK_PROVIDER` in `.env` — no code changes needed.

## 2. Run the backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API will be live at `http://localhost:8000`. Health check: `GET /`, prediction: `POST /predict` (multipart file upload, field name `file`).

## 3. Open the frontend

Open `frontend/index.html` directly in a browser, or serve it with `python -m http.server` from the `frontend` folder. It calls the backend at `http://localhost:8000/predict`.

## Notes for the report / viva

- The core detection model (CNN trained on plant images) lives inside the plant.id service — it's a pretrained third-party model, not trained by you.
- The fallback step is a small "AI ensemble" pattern: when the specialist model is unsure, a general-purpose vision-language model (Gemini/GPT-4o) is asked for a second opinion. This is a legitimate, explainable design choice worth mentioning — it's not meant to always be "more accurate," it's there to give a useful answer instead of a low-confidence guess.
- You can extend this later by adding your own trained model (e.g. transfer learning on the PlantVillage dataset) behind the same `/predict` endpoint as a "Phase 2" if time allows.
