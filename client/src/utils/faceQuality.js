/**
 * MADRASA AMANAH — FACE DETECTION IMAGE QUALITY & VALIDATION
 * Checks resolution, luminance (lighting), and contrast to prevent false face matches
 * before running embedding comparisons.
 */

export function checkImageQuality(canvasOrImg) {
  if (!canvasOrImg) return { ok: false, message: "No image source provided for quality assessment." };

  const width = canvasOrImg.naturalWidth || canvasOrImg.videoWidth || canvasOrImg.width || 0;
  const height = canvasOrImg.naturalHeight || canvasOrImg.videoHeight || canvasOrImg.height || 0;

  if (width < 160 || height < 160) {
    return {
      ok: false,
      reason: "low-resolution",
      message: "The captured photo is too low-resolution for reliable face recognition. Please bring the camera closer."
    };
  }

  try {
    const sampleSize = 100;
    const canvas = document.createElement("canvas");
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: true };

    ctx.drawImage(canvasOrImg, 0, 0, sampleSize, sampleSize);
    const imgData = ctx.getImageData(0, 0, sampleSize, sampleSize);
    const data = imgData.data;

    let totalLuminance = 0;
    let minLum = 255;
    let maxLum = 0;
    const count = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      totalLuminance += lum;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const meanLuminance = totalLuminance / count;
    const dynamicRange = maxLum - minLum;

    // Underexposed
    if (meanLuminance < 30) {
      return {
        ok: false,
        reason: "too-dark",
        message: "The photo is too dark. Please ensure adequate lighting on the student's face before scanning."
      };
    }

    // Overexposed / harsh washout
    if (meanLuminance > 235) {
      return {
        ok: false,
        reason: "too-bright",
        message: "The photo has excessive glare or backlighting. Please adjust the camera position."
      };
    }

    // Very low contrast / severe blur
    if (dynamicRange < 30) {
      return {
        ok: false,
        reason: "low-contrast",
        message: "The photo appears blurry or lacks clear facial contrast. Please hold the camera steady."
      };
    }

    return { ok: true, meanLuminance, dynamicRange };
  } catch (err) {
    console.warn("Quality check bypassed:", err);
    return { ok: true };
  }
}

/**
 * Calibrated match score classifier for 128D Face Embeddings.
 * Provides transparent confidence percentages and flags uncertainty.
 */
export function evaluateFaceMatch(distance, isAmbiguous = false) {
  if (distance === null || distance === undefined || isNaN(distance) || distance >= 900) {
    return {
      confidencePct: 0,
      tier: "none",
      label: "Unmatched",
      isConfident: false,
      isUncertain: true
    };
  }

  // Distance semantics for dlib/ResNet 128D:
  // <= 0.35: Strong Match (85% - 100%)
  // 0.36 - 0.44: Good Match (65% - 84%)
  // 0.45 - 0.50: Borderline Candidate (45% - 64%)
  // > 0.50: Different person / reject
  let confidencePct = 0;
  if (distance <= 0.35) {
    confidencePct = Math.round(85 + ((0.35 - distance) / 0.35) * 15);
  } else if (distance <= 0.44) {
    confidencePct = Math.round(65 + ((0.44 - distance) / 0.09) * 19);
  } else if (distance <= 0.50) {
    confidencePct = Math.round(45 + ((0.50 - distance) / 0.06) * 19);
  } else {
    confidencePct = Math.max(0, Math.round((1 - (distance / 0.65)) * 40));
  }
  confidencePct = Math.max(0, Math.min(100, confidencePct));

  // Determine confidence tier
  const isConfident = distance <= 0.44 && !isAmbiguous;
  const isUncertain = distance > 0.44 || isAmbiguous;

  let tier = "none";
  let label = "Unmatched";
  if (confidencePct >= 75 && !isAmbiguous) {
    tier = "high";
    label = "High Confidence";
  } else if (confidencePct >= 60 && !isAmbiguous) {
    tier = "medium";
    label = "Good Match";
  } else if (confidencePct >= 45) {
    tier = "low";
    label = isAmbiguous ? "Ambiguous Match" : "Uncertain Match";
  }

  return {
    confidencePct,
    tier,
    label,
    isConfident,
    isUncertain: isUncertain || isAmbiguous
  };
}
