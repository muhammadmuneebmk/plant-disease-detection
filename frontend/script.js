// Update LIVE_BACKEND_URL after deploying the backend (Railway/Render/etc).
const LIVE_BACKEND_URL = "https://plant-disease-detection-backend-production-78e7.up.railway.app";
const IS_LOCAL = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = IS_LOCAL ? "http://localhost:8000" : LIVE_BACKEND_URL;
const MAX_IMAGES = 3;

// ---------- tab switching ----------
document.querySelectorAll(".nav-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    document.getElementById("view-detect").hidden = target !== "detect";
    document.getElementById("view-finder").hidden = target !== "finder";
  });
});

// ---------- shared: disease name mapping ----------
const COMMON_DISEASE_NAMES = {
  erysiphaceae: "Powdery Mildew",
  peronosporaceae: "Downy Mildew",
  puccinia: "Rust",
  pucciniales: "Rust",
  alternaria: "Alternaria Leaf Spot",
  "botrytis cinerea": "Gray Mold",
  botrytis: "Gray Mold",
  fusarium: "Fusarium Wilt",
  septoria: "Septoria Leaf Spot",
  colletotrichum: "Anthracnose",
  venturia: "Scab",
  phytophthora: "Phytophthora Blight",
  xanthomonas: "Bacterial Leaf Spot",
  "pseudomonas syringae": "Bacterial Speck",
  erwinia: "Fire Blight / Soft Rot",
  "agrobacterium tumefaciens": "Crown Gall",
  cercospora: "Cercospora Leaf Spot",
  tobamovirus: "Mosaic Virus",
  potyvirus: "Mosaic Virus",
};

function toCommonName(name) {
  if (!name) return null;
  return COMMON_DISEASE_NAMES[name.trim().toLowerCase()] || null;
}

const FALLBACK_LABELS = { gemini: "Gemini", openai: "GPT-4o" };

function extractErrorMessage(err, status) {
  const detail = err && err.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
  }
  return `Request failed (${status})`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setMeter(meterEl, labelEl, probability) {
  if (probability == null) {
    meterEl.style.width = "0%";
    labelEl.textContent = "-";
    return;
  }
  const pct = Math.round(probability * 100);
  labelEl.textContent = `${pct}%`;
  requestAnimationFrame(() => {
    meterEl.style.width = `${pct}%`;
  });
}

// ---------- reusable multi-image uploader ----------
function createUploader({ boxId, inputId, thumbRowId, btnId, onFilesChange }) {
  const box = document.getElementById(boxId);
  const input = document.getElementById(inputId);
  const thumbRow = document.getElementById(thumbRowId);
  const btn = document.getElementById(btnId);
  let files = [];

  function render() {
    thumbRow.innerHTML = "";
    files.forEach((file, i) => {
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove";
      removeBtn.textContent = "✕";
      removeBtn.onclick = (e) => {
        e.preventDefault();
        files.splice(i, 1);
        render();
      };
      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      thumbRow.appendChild(thumb);
    });
    btn.disabled = files.length === 0;
    onFilesChange && onFilesChange(files.length > 0);
  }

  function addFiles(fileList) {
    for (const f of fileList) {
      if (files.length >= MAX_IMAGES) break;
      if (f.type.startsWith("image/")) files.push(f);
    }
    render();
  }

  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    box.addEventListener(evt, (e) => {
      e.preventDefault();
      box.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    box.addEventListener(evt, (e) => {
      e.preventDefault();
      box.classList.remove("drag-over");
    })
  );
  box.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  return {
    getFiles: () => files,
    reset: () => {
      files = [];
      render();
    },
  };
}

function setLoading(btn, isLoading) {
  const label = btn.querySelector(".btn-label");
  const spinner = btn.querySelector(".btn-spinner");
  btn.disabled = isLoading;
  label.textContent = isLoading ? "Working..." : label.dataset.idle;
  spinner.hidden = !isLoading;
}

function runAgentSteps(container, steps) {
  container.innerHTML = "";
  container.hidden = false;

  const els = steps.map((label, i) => {
    const div = document.createElement("div");
    div.className = "agent-step";
    div.style.animationDelay = `${i * 0.15}s`;
    div.innerHTML = `<span class="dot"></span><span>${label}</span>`;
    container.appendChild(div);
    return div;
  });

  let i = 0;
  const timer = setInterval(() => {
    if (els[i]) els[i].classList.add("done");
    i++;
    if (i >= els.length) clearInterval(timer);
  }, 500);

  return () => {
    clearInterval(timer);
    els.forEach((el) => el.classList.add("done"));
  };
}

// ================= Detect Disease =================
const btnDetect = document.getElementById("btn-detect");
btnDetect.querySelector(".btn-label").dataset.idle = "Analyze";

const detectUploader = createUploader({
  boxId: "box-detect",
  inputId: "input-detect",
  thumbRowId: "thumbs-detect",
  btnId: "btn-detect",
});

btnDetect.addEventListener("click", async () => {
  const files = detectUploader.getFiles();
  if (!files.length) return;

  setLoading(btnDetect, true);
  document.getElementById("status-detect").textContent = "";
  document.getElementById("result-detect").hidden = true;

  const finishSteps = runAgentSteps(document.getElementById("steps-detect"), [
    "Reading image",
    "Consulting plant.id model",
    "Compiling diagnosis",
  ]);

  const formData = new FormData();
  files.forEach((f) => formData.append("files", f));

  try {
    const response = await fetch(`${API_BASE}/predict`, { method: "POST", body: formData });
    finishSteps();
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(extractErrorMessage(err, response.status));
    }
    const data = await response.json();
    renderDetectResult(data);
  } catch (err) {
    finishSteps();
    document.getElementById("status-detect").textContent = `Error: ${err.message}`;
  } finally {
    setLoading(btnDetect, false);
    setTimeout(() => (document.getElementById("steps-detect").hidden = true), 400);
  }
});

function renderDetectResult(data) {
  document.getElementById("empty-detect").hidden = true;
  const resultEl = document.getElementById("result-detect");

  const crop = data.crop || {};
  const disease = data.disease || {};

  document.getElementById("cropName").textContent = crop.name || "Unknown";
  setMeter(document.getElementById("cropMeter"), document.getElementById("cropProb"), crop.probability);

  const commonName = toCommonName(disease.name);
  document.getElementById("diseaseName").textContent = disease.name
    ? commonName
      ? `${commonName} (${disease.name})`
      : disease.name
    : "Unknown";
  setMeter(document.getElementById("diseaseMeter"), document.getElementById("diseaseProb"), disease.probability);

  const extraDetails = document.getElementById("extraDetails");
  extraDetails.innerHTML = "";
  const details = disease.details || {};

  if (disease.is_healthy) {
    const p = document.createElement("p");
    p.textContent = "The plant looks healthy.";
    extraDetails.appendChild(p);
  } else {
    if (details.description) extraDetails.appendChild(makeSection("Description", details.description));
    if (details.treatment) extraDetails.appendChild(makeTreatmentSection(details.treatment));
  }

  const fallbackSection = document.getElementById("fallbackSection");
  fallbackSection.innerHTML = "";
  if (data.fallback && data.fallback.analysis) {
    const label = FALLBACK_LABELS[data.fallback.provider] || data.fallback.provider;
    fallbackSection.hidden = false;
    fallbackSection.innerHTML = `
      <h4>🤖 Second opinion from ${label} <span style="font-weight:400;color:var(--text-dim)">(confidence was low)</span></h4>
      <p>${escapeHtml(data.fallback.analysis)}</p>
    `;
  } else {
    fallbackSection.hidden = true;
  }

  resultEl.hidden = false;
}

function makeSection(title, content) {
  const div = document.createElement("div");
  const h4 = document.createElement("h4");
  h4.textContent = title;
  const p = document.createElement("p");
  p.textContent = typeof content === "string" ? content : JSON.stringify(content);
  div.appendChild(h4);
  div.appendChild(p);
  return div;
}

function makeTreatmentSection(treatment) {
  const div = document.createElement("div");
  const h4 = document.createElement("h4");
  h4.textContent = "Treatment";
  div.appendChild(h4);

  ["biological", "chemical", "prevention"].forEach((key) => {
    const items = treatment[key];
    if (items && items.length) {
      const label = document.createElement("strong");
      label.textContent = `${key.charAt(0).toUpperCase() + key.slice(1)}: `;
      const p = document.createElement("p");
      p.appendChild(label);
      p.appendChild(document.createTextNode(Array.isArray(items) ? items.join(", ") : items));
      div.appendChild(p);
    }
  });

  return div;
}

// ================= Plant Finder =================
const btnFinder = document.getElementById("btn-finder");
btnFinder.querySelector(".btn-label").dataset.idle = "Identify";

const finderUploader = createUploader({
  boxId: "box-finder",
  inputId: "input-finder",
  thumbRowId: "thumbs-finder",
  btnId: "btn-finder",
});

btnFinder.addEventListener("click", async () => {
  const files = finderUploader.getFiles();
  if (!files.length) return;

  setLoading(btnFinder, true);
  document.getElementById("status-finder").textContent = "";
  document.getElementById("result-finder").hidden = true;

  const finishSteps = runAgentSteps(document.getElementById("steps-finder"), [
    "Reading image",
    "Matching plant species",
    "Gathering plant info",
  ]);

  const formData = new FormData();
  files.forEach((f) => formData.append("files", f));

  try {
    const response = await fetch(`${API_BASE}/identify`, { method: "POST", body: formData });
    finishSteps();
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(extractErrorMessage(err, response.status));
    }
    const data = await response.json();
    renderFinderResult(data);
  } catch (err) {
    finishSteps();
    document.getElementById("status-finder").textContent = `Error: ${err.message}`;
  } finally {
    setLoading(btnFinder, false);
    setTimeout(() => (document.getElementById("steps-finder").hidden = true), 400);
  }
});

function renderFinderResult(data) {
  const plant = data.plant;
  if (!plant) {
    document.getElementById("status-finder").textContent = "No plant could be identified in this photo.";
    return;
  }

  document.getElementById("empty-finder").hidden = true;
  const resultEl = document.getElementById("result-finder");
  const details = plant.details || {};

  document.getElementById("finderName").textContent = plant.name || "Unknown";
  setMeter(document.getElementById("finderMeter"), document.getElementById("finderProb"), plant.probability);

  const img = document.getElementById("finderImg");
  const imageUrl = typeof details.image === "string" ? details.image : details.image && details.image.value;
  if (imageUrl) {
    img.src = imageUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  const finderDetails = document.getElementById("finderDetails");
  finderDetails.innerHTML = "";

  if (details.common_names && details.common_names.length) {
    finderDetails.appendChild(makeSection("Common names", details.common_names.join(", ")));
  }
  if (details.description) {
    const desc = typeof details.description === "string" ? details.description : details.description.value;
    if (desc) finderDetails.appendChild(makeSection("Description", desc));
  }
  if (details.best_watering) finderDetails.appendChild(makeSection("Watering", details.best_watering));
  if (details.best_light_condition) finderDetails.appendChild(makeSection("Light", details.best_light_condition));
  if (details.best_soil_type) finderDetails.appendChild(makeSection("Soil", details.best_soil_type));
  if (details.toxicity) finderDetails.appendChild(makeSection("Toxicity", details.toxicity));
  if (details.edible_parts && details.edible_parts.length) {
    finderDetails.appendChild(makeSection("Edible parts", details.edible_parts.join(", ")));
  }

  resultEl.hidden = false;
}
