// =====================
// Constants
// =====================
const GRAVITY = 9.80665;
const AIR_DENSITY = 1.2;
const BALL_MASS = 0.04593;
const BALL_DIAMETER = 0.04267;
const BALL_RADIUS = BALL_DIAMETER / 2;
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const AIR_KINEMATIC_VISCOSITY = 1.5e-5;

// (旧) RUN_COEFFICIENT は使わなくなるけど残してOK
const RUN_COEFFICIENT = 0.01;

const METERS_PER_YARD = 0.9144;
const EPSILON = 1e-6;
const X_TICK_YARDS = 50;

// --- Spin decay (4%/s) ---
const SPIN_DECAY_RATE = 0.04; // 1/s

// --- Cd(Re,S) extension (KK-based Cd(Re) + linear S term) ---
// Cd = Cd0(Re) + CD_SPIN_LINEAR * S
const CD_SPIN_LINEAR = 0.35;

// --- Simple landing/run model params (temporary) ---
const RUN_BASE = 0.035;
const LANDING_POWER = 2.2;
const SPIN_SCALE_RPM = 3200;
const SPIN_POWER = 1.4;

function computeWindDisplayValue(rawWindValue) {
  return -rawWindValue;
}

function toPhysicsWind(rawWindValue) {
  return -rawWindValue;
}

function computeMaxDisplayMeters(currentTotalMeters, previousTotalMeters) {
  const maxTotalMeters = Math.max(currentTotalMeters || 0, previousTotalMeters || 0);
  const paddedYards = maxTotalMeters / METERS_PER_YARD + 50;
  const roundedYards = Math.ceil(paddedYards / X_TICK_YARDS) * X_TICK_YARDS;
  return Math.max(roundedYards * METERS_PER_YARD, 150 * METERS_PER_YARD);
}

// =====================
// DOM
// =====================
const hasDom = typeof document !== "undefined";
const form = hasDom ? document.getElementById("distance-form") : null;
const errorMessage = hasDom ? document.getElementById("error-message") : null;
const carryResult = hasDom ? document.getElementById("carryResult") : null;
const totalResult = hasDom ? document.getElementById("totalResult") : null;
const maxHeightResult = hasDom ? document.getElementById("maxHeightResult") : null;
const ballSpeedPreview = hasDom ? document.getElementById("ballSpeedPreview") : null;
const canvas = hasDom ? document.getElementById("trajectoryCanvas") : null;
const ctx = canvas ? canvas.getContext("2d") : null;

const headSpeedInput = hasDom ? document.getElementById("headSpeed") : null;
const smashFactorInput = hasDom ? document.getElementById("smashFactor") : null;
const launchAngleInput = hasDom ? document.getElementById("launchAngle") : null;
const spinRateInput = hasDom ? document.getElementById("spinRate") : null;
const windSpeedInput = hasDom ? document.getElementById("windSpeed") : null;

const headSpeedValue = hasDom ? document.getElementById("headSpeedValue") : null;
const smashFactorValue = hasDom ? document.getElementById("smashFactorValue") : null;
const launchAngleValue = hasDom ? document.getElementById("launchAngleValue") : null;
const spinRateValue = hasDom ? document.getElementById("spinRateValue") : null;
const windSpeedValue = hasDom ? document.getElementById("windSpeedValue") : null;

let previousResult = null;

function showError(message) {
  if (!errorMessage) return;
  errorMessage.textContent = message;
  errorMessage.classList.add("show");
}

function clearError() {
  if (!errorMessage) return;
  errorMessage.textContent = "";
  errorMessage.classList.remove("show");
}

function clamp(x, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cdFromRe(re) {
  const cdLow = 1.29e-10 * re * re - 2.59e-5 * re + 1.5;
  const cdHigh = 1.91e-11 * re * re - 5.4e-6 * re + 0.56;
  const reBlendStart = 75000;
  const reBlendEnd = 100000;

  if (re <= reBlendStart) return cdLow;
  if (re >= reBlendEnd) return cdHigh;

  const t = (re - reBlendStart) / (reBlendEnd - reBlendStart);
  return lerp(cdLow, cdHigh, t);
}

function clFromSpinFactor(s) {
  return Math.max(0, -3.25 * s * s + 1.99 * s);
}

function spinFactorFrom(speed, spinRpm) {
  const omega = (spinRpm * 2 * Math.PI) / 60;
  return (omega * BALL_RADIUS) / Math.max(speed, EPSILON);
}

// 風スライダーは中央0、左右にカラーバーを伸ばす
function updateWindSliderIndicator() {
  if (!windSpeedInput) return;
  const min = Number(windSpeedInput.min);
  const max = Number(windSpeedInput.max);
  const rawVal = Number(windSpeedInput.value);
  const centerPct = ((0 - min) / (max - min)) * 100;
  const valPct = ((rawVal - min) / (max - min)) * 100;

  if (Math.abs(rawVal) < 1e-9) {
    windSpeedInput.style.background = "linear-gradient(to right, #cfd8e3 0%, #cfd8e3 100%)";
    return;
  }

  if (rawVal > 0) {
    windSpeedInput.style.background = `linear-gradient(to right, #cfd8e3 0%, #cfd8e3 ${centerPct}%, #ff8a80 ${centerPct}%, #ff5a4f ${valPct}%, #cfd8e3 ${valPct}%, #cfd8e3 100%)`;
  } else {
    windSpeedInput.style.background = `linear-gradient(to right, #cfd8e3 0%, #cfd8e3 ${valPct}%, #4f9dff ${valPct}%, #2b78ff ${centerPct}%, #cfd8e3 ${centerPct}%, #cfd8e3 100%)`;
  }
}

function effectiveSpinRate(spinRate) {
  if (spinRate <= 3000) return spinRate;
  const t = (spinRate - 3000) / 2000;
  return lerp(3000, 3800, t);
}

function spinAtTimeRpm(spin0Rpm, tSec) {
  return spin0Rpm * Math.exp(-SPIN_DECAY_RATE * tSec);
}

function computeRunMetersFromLanding(landingVx, landingVy, spinLandRpm) {
  const vx = Math.max(landingVx, EPSILON);
  const gamma = Math.atan(Math.abs(landingVy) / vx);

  const angleFactor = Math.pow(Math.cos(gamma), LANDING_POWER);
  const spinFactor = 1 / (1 + Math.pow(spinLandRpm / SPIN_SCALE_RPM, SPIN_POWER));

  return Math.max(0, RUN_BASE * vx * vx * angleFactor * spinFactor);
}

function updateOutputs() {
  if (!headSpeedInput) return;
  const headSpeed = Number(headSpeedInput.value);
  const smashFactor = Number(smashFactorInput.value);

  headSpeedValue.textContent = headSpeed.toFixed(1);
  smashFactorValue.textContent = smashFactor.toFixed(2);
  launchAngleValue.textContent = `${Number(launchAngleInput.value).toFixed(1)}°`;
  spinRateValue.textContent = Number(spinRateInput.value).toFixed(0);

  const windRaw = Number(windSpeedInput.value);
  const windForDisplay = computeWindDisplayValue(windRaw);
  windSpeedValue.textContent = windForDisplay.toFixed(1);
  updateWindSliderIndicator();

  ballSpeedPreview.textContent = `${(headSpeed * smashFactor).toFixed(1)} m/s`;
}

function interpolateAtGround(previous, current) {
  const ratio = previous.y / Math.max(previous.y - current.y, EPSILON);
  return {
    x: previous.x + (current.x - previous.x) * ratio,
    y: 0,
    vx: previous.vx + (current.vx - previous.vx) * ratio,
    vy: previous.vy + (current.vy - previous.vy) * ratio,
  };
}

function simulateFlight(ballSpeed, launchAngleDeg, spinRate, windSpeed) {
  const launchRad = (launchAngleDeg * Math.PI) / 180;
  const dt = 0.01;

  let state = {
    x: 0,
    y: 0,
    vx: ballSpeed * Math.cos(launchRad),
    vy: ballSpeed * Math.sin(launchRad),
  };

  let maxHeight = 0;
  const trajectory = [{ x: 0, y: 0 }];
  let landingState = state;
  let tSec = 0;

  for (let i = 0; i < 3000; i += 1) {
    const previous = { ...state };

    const relVx = state.vx + windSpeed;
    const relVy = state.vy;
    const airSpeed = Math.max(Math.hypot(relVx, relVy), EPSILON);

    const re = (airSpeed * BALL_DIAMETER) / AIR_KINEMATIC_VISCOSITY;
    const reClamped = clamp(re, 50000, 200000);

    const spin0 = effectiveSpinRate(spinRate);
    const spinNow = spinAtTimeRpm(spin0, tSec);
    const S = spinFactorFrom(airSpeed, spinNow);

    const cl = clFromSpinFactor(S);
    const cd0 = cdFromRe(reClamped);
    const cd = clamp(cd0 + CD_SPIN_LINEAR * S, 0.05, 1.2);

    const dragForce = 0.5 * AIR_DENSITY * cd * BALL_AREA * airSpeed * airSpeed;
    const liftForce = 0.5 * AIR_DENSITY * cl * BALL_AREA * airSpeed * airSpeed;

    const ax = (-dragForce * relVx / airSpeed - liftForce * relVy / airSpeed) / BALL_MASS;
    const ay = -GRAVITY + (-dragForce * relVy / airSpeed + liftForce * relVx / airSpeed) / BALL_MASS;

    state.vx += ax * dt;
    state.vy += ay * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;

    maxHeight = Math.max(maxHeight, state.y);

    if (state.y < 0) {
      const ratio = previous.y / Math.max(previous.y - state.y, EPSILON);
      tSec += dt * ratio;

      landingState = interpolateAtGround(previous, state);
      trajectory.push({ x: landingState.x, y: 0 });
      break;
    }

    trajectory.push({ x: state.x, y: state.y });
    landingState = { ...state };
    tSec += dt;
  }

  return {
    carryMeters: Math.max(landingState.x, 0),
    maxHeightMeters: Math.max(maxHeight, 0),
    landingVx: landingState.vx,
    landingVy: landingState.vy,
    flightTimeSec: tSec,
    trajectory,
  };
}

function calculateDistances(headSpeed, smashFactor, launchAngleDeg, spinRate, windSpeed) {
  const ballSpeed = headSpeed * smashFactor;
  const flight = simulateFlight(ballSpeed, launchAngleDeg, spinRate, windSpeed);

  const spin0 = effectiveSpinRate(spinRate);
  const spinLand = spinAtTimeRpm(spin0, flight.flightTimeSec);

  const runMeters = computeRunMetersFromLanding(
    flight.landingVx,
    flight.landingVy,
    spinLand
  );

  return {
    ballSpeed,
    carryMeters: flight.carryMeters,
    totalMeters: flight.carryMeters + runMeters,
    trajectory: flight.trajectory,
    maxHeightMeters: flight.maxHeightMeters,
  };
}

function validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw, spinRateRaw, windSpeedRaw) {
  if (!headSpeedRaw || !smashFactorRaw || !launchAngleRaw || !spinRateRaw || !windSpeedRaw) {
    return "すべての入力欄を入力してください。";
  }

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);
  const spinRate = Number(spinRateRaw);
  const windSpeed = Number(windSpeedRaw);

  if (!Number.isFinite(headSpeed) || !Number.isFinite(smashFactor) || !Number.isFinite(launchAngle) || !Number.isFinite(spinRate) || !Number.isFinite(windSpeed)) {
    return "数値形式で入力してください。";
  }

  if (headSpeed <= 0 || smashFactor <= 0 || launchAngle <= 0 || spinRate <= 0) {
    return "0より大きい値を入力してください。";
  }

  if (headSpeed < 25 || headSpeed > 60) {
    return "ヘッドスピードは 25.0〜60.0 の範囲で入力してください。";
  }

  if (smashFactor < 1.3 || smashFactor > 1.56) {
    return "ミート率は 1.30〜1.56 の範囲で入力してください。";
  }

  if (launchAngle < 10 || launchAngle > 18) {
    return "打ち出し角は 10.0〜18.0 度の範囲で入力してください。";
  }

  if (spinRate < 1500 || spinRate > 5000) {
    return "スピンレートは 1500〜5000 rpm の範囲で入力してください。";
  }

  if (windSpeed < -10 || windSpeed > 10) {
    return "風向風速は -10.0〜10.0 m/s の範囲で入力してください。";
  }

  return null;
}

function drawSingleTrajectory(trajectory, color, lineWidth, alpha, scaleX, scaleY, pad, groundY, maxDisplayMeters, peakColor = "#ff4d4f") {
  if (!ctx || !canvas) return { landingX: 0, peakPoint: { x: 0, y: 0 }, overflow: false };
  const maxXPixel = canvas.width - pad;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  let started = false;
  let peakPoint = { x: pad, y: groundY };
  let clippedAtEdge = false;

  for (const point of trajectory) {
    if (point.x > maxDisplayMeters) {
      clippedAtEdge = true;
      break;
    }

    const px = pad + point.x * scaleX;
    const py = groundY - point.y * scaleY;

    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }

    if (py < peakPoint.y) {
      peakPoint = { x: px, y: py };
    }
  }

  if (clippedAtEdge && trajectory.length >= 2) {
    const prev = trajectory.findLast((p) => p.x <= maxDisplayMeters);
    const next = trajectory.find((p) => p.x > maxDisplayMeters);
    if (prev && next) {
      const t = (maxDisplayMeters - prev.x) / Math.max(next.x - prev.x, EPSILON);
      const yAtEdge = prev.y + (next.y - prev.y) * t;
      const pyEdge = groundY - yAtEdge * scaleY;
      ctx.lineTo(maxXPixel, pyEdge);
      if (pyEdge < peakPoint.y) peakPoint = { x: maxXPixel, y: pyEdge };
    }
  }

  ctx.stroke();

  const carryMeters = trajectory[trajectory.length - 1]?.x ?? 0;
  const overflow = carryMeters > maxDisplayMeters;
  const landingX = overflow ? maxXPixel : pad + carryMeters * scaleX;

  ctx.fillStyle = color;
  if (!overflow) {
    ctx.beginPath();
    ctx.arc(landingX, groundY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = peakColor;
  ctx.beginPath();
  ctx.arc(peakPoint.x, peakPoint.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return { landingX, peakPoint, overflow };
}

function drawRunSegment(result, color, scaleX, pad, groundY, maxDisplayMeters, alpha = 1) {
  if (!ctx || !canvas) return;
  const carryX = Math.min(pad + result.carryMeters * scaleX, canvas.width - pad);
  const totalX = Math.min(pad + result.totalMeters * scaleX, canvas.width - pad);

  if (totalX <= carryX + 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(carryX, groundY - 1);
  ctx.lineTo(totalX, groundY - 1);
  ctx.stroke();

  if (result.totalMeters <= maxDisplayMeters) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(totalX, groundY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTrajectory(currentResult, previous) {
  if (!ctx || !canvas) return;
  const pad = 36;
  const groundY = canvas.height - pad;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const groundGradient = ctx.createLinearGradient(0, groundY, 0, canvas.height);
  groundGradient.addColorStop(0, "rgba(110, 187, 110, 0.55)");
  groundGradient.addColorStop(1, "rgba(56, 122, 56, 0.85)");
  ctx.fillStyle = groundGradient;
  ctx.fillRect(pad, groundY, canvas.width - pad * 2, canvas.height - groundY);

  ctx.strokeStyle = "#d0e2ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, groundY);
  ctx.lineTo(canvas.width - pad, groundY);
  ctx.stroke();

  const width = canvas.width - pad * 2;
  const height = canvas.height - pad * 2;

  const maxDisplayMeters = computeMaxDisplayMeters(currentResult.totalMeters, previous?.totalMeters || 0);

  const scaleX = width / maxDisplayMeters;
  const scaleY = height / Math.max(Math.max(currentResult.maxHeightMeters, previous?.maxHeightMeters || 0) * 1.35, 1);

  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  const maxDisplayYards = Math.floor(maxDisplayMeters / METERS_PER_YARD);
  for (let yard = X_TICK_YARDS; yard <= maxDisplayYards; yard += X_TICK_YARDS) {
    const x = pad + yard * METERS_PER_YARD * scaleX;
    ctx.beginPath();
    ctx.moveTo(x, groundY);
    ctx.lineTo(x, groundY - 8);
    ctx.stroke();
    ctx.fillStyle = "rgba(230,240,255,0.8)";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${yard}`, x - 10, groundY + 16);
  }

  if (previous) {
    drawSingleTrajectory(previous.trajectory, "#8ea0b4", 2, 0.35, scaleX, scaleY, pad, groundY, maxDisplayMeters, "#c66");
    drawRunSegment(previous, "#8ea0b4", scaleX, pad, groundY, maxDisplayMeters, 0.45);
  }

  const currentMarks = drawSingleTrajectory(currentResult.trajectory, "#41a5ff", 3, 1, scaleX, scaleY, pad, groundY, maxDisplayMeters, "#ff3b30");
  drawRunSegment(currentResult, "#111", scaleX, pad, groundY, maxDisplayMeters, 1);

  ctx.fillStyle = "#f3f7ff";
  ctx.font = "14px sans-serif";
  ctx.fillText("着弾点", currentMarks.landingX - 18, groundY - 10);
  ctx.fillText("最大到達点", currentMarks.peakPoint.x - 36, currentMarks.peakPoint.y - 12);
  ctx.fillText(`${Math.round(maxDisplayMeters / METERS_PER_YARD)} yd`, canvas.width - pad - 42, groundY - 12);
}

if (hasDom && form && headSpeedInput && smashFactorInput && launchAngleInput && spinRateInput && windSpeedInput) {
  [headSpeedInput, smashFactorInput, launchAngleInput, spinRateInput, windSpeedInput].forEach((input) => {
    input.addEventListener("input", updateOutputs);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const headSpeedRaw = headSpeedInput.value.trim();
    const smashFactorRaw = smashFactorInput.value.trim();
    const launchAngleRaw = launchAngleInput.value.trim();
    const spinRateRaw = spinRateInput.value.trim();
    const windSpeedRaw = windSpeedInput.value.trim();

    const error = validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw, spinRateRaw, windSpeedRaw);

    if (error) {
      showError(error);
      maxHeightResult.textContent = "-";
      carryResult.textContent = "-";
      totalResult.textContent = "-";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    clearError();

    const result = calculateDistances(
      Number(headSpeedRaw),
      Number(smashFactorRaw),
      Number(launchAngleRaw),
      Number(spinRateRaw),
      toPhysicsWind(Number(windSpeedRaw))
    );

    const carryYd = result.carryMeters / METERS_PER_YARD;
    const totalYd = result.totalMeters / METERS_PER_YARD;

    maxHeightResult.textContent = `${result.maxHeightMeters.toFixed(1)} m`;
    carryResult.textContent = `${carryYd.toFixed(1)} yd`;
    totalResult.textContent = `${totalYd.toFixed(1)} yd`;

    drawTrajectory(result, previousResult);
    previousResult = result;
  });

  updateOutputs();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeWindDisplayValue,
    toPhysicsWind,
    computeMaxDisplayMeters,
    calculateDistances,
    validateInputs,
  };
}
