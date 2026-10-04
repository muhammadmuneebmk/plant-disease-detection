// Update LIVE_BACKEND_URL after deploying the backend (Railway/Render/etc).
const LIVE_BACKEND_URL = "https://plant-disease-detection-backend-production-78e7.up.railway.app";
const IS_LOCAL = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = IS_LOCAL ? "http://localhost:8000" : LIVE_BACKEND_URL;
const MIN_IMAGES = 3;
const MAX_IMAGES = 5;

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
function createUploader({ boxId, inputId, thumbRowId, btnId, minFiles = 1, onCountChange }) {
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
    btn.disabled = files.length < minFiles;
    onCountChange && onCountChange(files.length);
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

function updatePhotoCount(el, count) {
  const ready = count >= MIN_IMAGES;
  if (!ready) {
    el.textContent = `${count} photo${count === 1 ? "" : "s"} added. Add ${MIN_IMAGES - count} more of the same plant (minimum ${MIN_IMAGES}).`;
  } else if (count < MAX_IMAGES) {
    const extra = MAX_IMAGES - count;
    el.textContent = `${count} photos added. Ready. You can add ${extra} more angle${extra === 1 ? "" : "s"} if you like.`;
  } else {
    el.textContent = `${count} photos added. Ready (maximum reached).`;
  }
  el.classList.toggle("complete", ready);
}

const detectUploader = createUploader({
  boxId: "box-detect",
  inputId: "input-detect",
  thumbRowId: "thumbs-detect",
  btnId: "btn-detect",
  minFiles: MIN_IMAGES,
  onCountChange: (count) => updatePhotoCount(document.getElementById("count-detect"), count),
});

btnDetect.addEventListener("click", async () => {
  const files = detectUploader.getFiles();
  if (files.length < MIN_IMAGES) return;

  setLoading(btnDetect, true);
  document.getElementById("status-detect").textContent = "";
  document.getElementById("result-detect").hidden = true;

  const finishSteps = runAgentSteps(document.getElementById("steps-detect"), [
    `Reading ${files.length} photos`,
    "Consulting plant.id model",
    "Checking confidence",
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

// "Gossypium hirsutum" + "upland cotton" -> "Gossypium hirsutum (Upland cotton)"
function withCommonName(scientific, common) {
  if (!scientific) return "Unknown";
  if (!common || common.toLowerCase() === scientific.toLowerCase()) return scientific;
  return `${scientific} (${common.charAt(0).toUpperCase()}${common.slice(1)})`;
}

function displayDiseaseName(name) {
  const commonName = toCommonName(name);
  return commonName ? `${commonName} (${name})` : name;
}

function renderDetectResult(data) {
  document.getElementById("empty-detect").hidden = true;
  const resultEl = document.getElementById("result-detect");
  const crop = data.crop || {};

  const cropProb = document.getElementById("cropProb");
  document.getElementById("cropName").textContent = withCommonName(crop.name, crop.common_name);
  setMeter(document.getElementById("cropMeter"), cropProb, crop.probability);
  if (crop.probability != null && crop.probability < 0.5) cropProb.textContent += " · low confidence";

  const diseaseName = document.getElementById("diseaseName");
  const diseaseMeter = document.getElementById("diseaseMeter");
  const diseaseProb = document.getElementById("diseaseProb");
  const extraDetails = document.getElementById("extraDetails");
  extraDetails.innerHTML = "";

  if (data.verdict === "healthy") {
    diseaseName.textContent = "Healthy";
    setMeter(diseaseMeter, diseaseProb, data.health_probability);
    if (data.health_probability != null) diseaseProb.textContent += " sure it's healthy";
    extraDetails.appendChild(makeSection("Result", "No disease was detected in these photos."));
  } else if (data.verdict === "diseased") {
    const disease = data.disease;
    const details = disease.details || {};
    diseaseName.textContent = displayDiseaseName(disease.name);
    setMeter(diseaseMeter, diseaseProb, disease.probability);
    if (details.description) extraDetails.appendChild(makeSection("Description", details.description));
    if (details.treatment) extraDetails.appendChild(makeTreatmentSection(details.treatment));
  } else {
    diseaseName.textContent = "Unclear";
    const hasHealth = data.health_probability != null;
    setMeter(diseaseMeter, diseaseProb, hasHealth ? 1 - data.health_probability : null);
    if (hasHealth) diseaseProb.textContent += " likely a problem, cause not confirmed";
    if (data.candidates && data.candidates.length) {
      const list = data.candidates
        .map((c) => `${displayDiseaseName(c.name)} (${Math.round(c.probability * 100)}%)`)
        .join(", ");
      extraDetails.appendChild(
        makeSection("Low-confidence possibilities", `${list}. None of these is reliable enough to treat as a diagnosis.`)
      );
    }
  }

  renderFallback(data.fallback);
  resultEl.hidden = false;
  scrollToResultOnMobile(resultEl);
}

// On stacked (mobile) layouts the result renders below the upload panel, out of view.
function scrollToResultOnMobile(el) {
  if (!matchMedia("(max-width: 900px)").matches) return;
  const navbarHeight = document.querySelector(".navbar").offsetHeight;
  const top = el.getBoundingClientRect().top + window.scrollY - navbarHeight - 12;
  window.scrollTo(0, top);
}

function renderFallback(fallback) {
  const section = document.getElementById("fallbackSection");
  section.innerHTML = "";
  if (!fallback || !fallback.diagnosis) {
    section.hidden = true;
    return;
  }

  const label = FALLBACK_LABELS[fallback.provider] || fallback.provider;
  const uncertain = fallback.diagnosis.trim().toLowerCase() === "uncertain";
  const heading = uncertain
    ? `${label} also can't tell from these photos`
    : `${label} second opinion: ${fallback.diagnosis} (${fallback.confidence} confidence)`;

  section.innerHTML = `<h4>🤖 ${escapeHtml(heading)}</h4>`;
  if (fallback.symptoms) {
    section.innerHTML += `<p><strong>What it sees:</strong> ${escapeHtml(fallback.symptoms)}</p>`;
  }
  if (!uncertain && fallback.treatment) {
    section.innerHTML += `<p><strong>Suggested action:</strong> ${escapeHtml(fallback.treatment)}</p>`;
  }
  section.hidden = false;
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
  minFiles: MIN_IMAGES,
  onCountChange: (count) => updatePhotoCount(document.getElementById("count-finder"), count),
});

btnFinder.addEventListener("click", async () => {
  const files = finderUploader.getFiles();
  if (files.length < MIN_IMAGES) return;

  setLoading(btnFinder, true);
  document.getElementById("status-finder").textContent = "";
  document.getElementById("result-finder").hidden = true;

  const finishSteps = runAgentSteps(document.getElementById("steps-finder"), [
    `Reading ${files.length} photos`,
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
    document.getElementById("status-finder").textContent = "No plant could be identified in these photos.";
    return;
  }

  document.getElementById("empty-finder").hidden = true;
  const resultEl = document.getElementById("result-finder");
  const details = plant.details || {};

  document.getElementById("finderName").textContent = withCommonName(plant.name, (details.common_names || [])[0]);
  const finderProb = document.getElementById("finderProb");
  setMeter(document.getElementById("finderMeter"), finderProb, plant.probability);
  if (plant.probability != null && plant.probability < 0.5) finderProb.textContent += " · low confidence";

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
  scrollToResultOnMobile(resultEl);
}

// ================= Photo guide modal =================
const PHONE_FRAME =
  '<rect x="18" y="6" width="84" height="108" rx="12" fill="#0f1a12" stroke="#4ade80" stroke-opacity="0.5" stroke-width="2"/>';

const LEAF_VEINS =
  '<path d="M60 24V98" stroke="#14532d" stroke-width="2"/>' +
  '<path d="M60 45L44 36M60 45L76 36M60 62L40 52M60 62L80 52M60 79L46 71M60 79L74 71" stroke="#14532d" stroke-width="1.5" fill="none"/>';

const ILLUSTRATIONS = {
  diseasedLeaf:
    PHONE_FRAME +
    '<path d="M60 16C90 30 96 72 60 104C24 72 30 30 60 16Z" fill="#22c55e"/>' +
    LEAF_VEINS +
    '<circle cx="48" cy="44" r="5" fill="#e5e7eb" opacity="0.85"/><circle cx="70" cy="58" r="6" fill="#e5e7eb" opacity="0.85"/>' +
    '<circle cx="52" cy="74" r="4" fill="#a16207"/><circle cx="72" cy="82" r="3" fill="#a16207"/>',
  leafUnderside:
    PHONE_FRAME +
    '<path d="M60 16C90 30 96 72 60 104C24 72 30 30 60 16Z" fill="#86efac"/>' +
    LEAF_VEINS +
    '<circle cx="45" cy="56" r="2.5" fill="#fef3c7"/><circle cx="50" cy="60" r="2.5" fill="#fef3c7"/><circle cx="74" cy="66" r="2.5" fill="#fef3c7"/>' +
    '<path d="M86 22a10 10 0 1 1-14 3" stroke="#facc15" stroke-width="2.5" fill="none"/><path d="M70 20l2 6 6-2" stroke="#facc15" stroke-width="2.5" fill="none"/>',
  healthyLeaf:
    PHONE_FRAME + '<path d="M60 16C90 30 96 72 60 104C24 72 30 30 60 16Z" fill="#22c55e"/>' + LEAF_VEINS,
  flowerOrBoll:
    PHONE_FRAME +
    '<path d="M60 104V64" stroke="#16a34a" stroke-width="3"/>' +
    '<circle cx="60" cy="38" r="11" fill="#fef3c7"/><circle cx="71.4" cy="46.3" r="11" fill="#fef3c7"/>' +
    '<circle cx="67.1" cy="59.7" r="11" fill="#fef3c7"/><circle cx="52.9" cy="59.7" r="11" fill="#fef3c7"/>' +
    '<circle cx="48.6" cy="46.3" r="11" fill="#fef3c7"/><circle cx="60" cy="50" r="6" fill="#facc15"/>' +
    '<circle cx="82" cy="90" r="10" fill="#4ade80"/><path d="M82 80V100M73 86L91 94" stroke="#15803d" stroke-width="1.5"/>',
  wholePlant:
    PHONE_FRAME +
    '<circle cx="88" cy="22" r="6" fill="#facc15"/>' +
    '<line x1="26" y1="100" x2="94" y2="100" stroke="#a16207" stroke-width="3"/>' +
    '<path d="M60 100V38" stroke="#16a34a" stroke-width="3"/>' +
    '<ellipse cx="46" cy="82" rx="13" ry="6" transform="rotate(-25 46 82)" fill="#22c55e"/>' +
    '<ellipse cx="74" cy="74" rx="13" ry="6" transform="rotate(25 74 74)" fill="#22c55e"/>' +
    '<ellipse cx="47" cy="60" rx="11" ry="5.5" transform="rotate(-25 47 60)" fill="#22c55e"/>' +
    '<ellipse cx="73" cy="52" rx="11" ry="5.5" transform="rotate(25 73 52)" fill="#22c55e"/>' +
    '<ellipse cx="60" cy="36" rx="7" ry="10" fill="#4ade80"/>',
};

const GUIDES = {
  detect: {
    title: "How to take your photos for disease detection",
    sub: "Take at least these 3 photos of the same plant (up to 5 in total). Each one shows the AI something different.",
    cards: [
      {
        art: "diseasedLeaf",
        title: "Affected leaf, close up",
        text: "Fill the frame with one leaf so spots, patches, or holes are clearly visible.",
      },
      {
        art: "leafUnderside",
        title: "Another angle",
        text: "A second affected leaf, or flip the same leaf over. Many pests hide underneath.",
      },
      {
        art: "wholePlant",
        title: "Whole plant",
        text: "Step back so the full plant fits. This shows whether the problem is spreading.",
      },
    ],
  },
  finder: {
    title: "How to take your photos for Plant Finder",
    sub: "Take at least these 3 photos of the same plant (up to 5 in total). Different parts help tell similar-looking species apart.",
    cards: [
      {
        art: "healthyLeaf",
        title: "Leaf, close up",
        text: "One flat leaf filling the frame. Its shape, edges, and veins are key clues.",
      },
      {
        art: "flowerOrBoll",
        title: "Flower, fruit, or boll",
        text: "The strongest clue for naming a plant. If it has none yet, photograph the stem instead.",
      },
      {
        art: "wholePlant",
        title: "Whole plant",
        text: "Shows the plant's height, shape, and how its leaves are arranged.",
      },
    ],
  },
};

const guideModal = document.getElementById("guide-modal");
let guideTrigger = null;

function openGuide(mode, trigger) {
  const guide = GUIDES[mode];
  document.getElementById("guide-title").textContent = guide.title;
  document.getElementById("guide-sub").textContent = guide.sub;
  document.getElementById("guide-cards").innerHTML = guide.cards
    .map(
      (card, i) => `
      <div class="guide-card">
        <svg viewBox="0 0 120 120" aria-hidden="true">${ILLUSTRATIONS[card.art]}</svg>
        <div>
          <span class="step">Photo ${i + 1}</span>
          <h4>${card.title}</h4>
          <p>${card.text}</p>
        </div>
      </div>`
    )
    .join("");

  guideTrigger = trigger;
  guideModal.hidden = false;
  document.body.classList.add("modal-open");
  guideModal.querySelector(".modal-close").focus();
}

function closeGuide() {
  guideModal.hidden = true;
  document.body.classList.remove("modal-open");
  if (guideTrigger) guideTrigger.focus();
}

document.querySelectorAll(".guide-link").forEach((btn) => {
  btn.addEventListener("click", () => openGuide(btn.dataset.guide, btn));
});
guideModal.querySelector(".modal-close").addEventListener("click", closeGuide);
guideModal.querySelector(".modal-ok").addEventListener("click", closeGuide);
guideModal.addEventListener("click", (e) => {
  if (e.target === guideModal) closeGuide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !guideModal.hidden) closeGuide();
});
