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

const METERS_PER_YARD = 0.9144;
const EPSILON = 1e-6;
const X_TICK_YARDS = 50;

const GROUND = {
  // Normal coefficient of restitution (vertical bounce)
  eN: 0.20,          // fairway-ish. 0.10 (soft) ... 0.30 (firm)
  // Kinetic friction coefficient during impact + sliding
  mu: 0.35,          // 0.25..0.55
  // Rolling resistance coefficient (pure rolling decel = cRR * g)
  cRR: 0.030,        // fairway 0.020..0.040, rough 0.050..0.080
  // Stop bouncing when post-bounce vertical speed is below this
  vyStop: 0.6,       // m/s
  // Safety limit
  maxBounces: 6,
};

// --- Spin decay (4%/s) ---
const SPIN_DECAY_RATE = 0.04; // 1/s

// --- Cd(Re,S) extension (KK-based Cd(Re) + linear S term) ---
// Cd = Cd0(Re) + CD_SPIN_LINEAR * S
const CD_SPIN_LINEAR = 0.35;

// --- Simple landing/run model params (temporary) ---
const RUN_BASE = 0.2;
const LANDING_POWER = 6;
const SPIN_SCALE_RPM = 3200;
const SPIN_POWER = 1.1;

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


function rpmToOmega(spinRpm) {
  return (spinRpm * 2 * Math.PI) / 60;
}
function omegaToRpm(omega) {
  return (omega * 60) / (2 * Math.PI);
}
function signNonZero(x) {
  return x >= 0 ? 1 : -1;
}

// Simple & stable run model (spin ignored)
// - landing angle reduces v0
// - rolling decel: dv/dt = -(a0 + k*v)
function computeRunMetersFromLanding(landingVx, landingVy, _spinLandRpmIgnored) {
  // Guard
  if (!Number.isFinite(landingVx) || !Number.isFinite(landingVy)) return 0;
  if (landingVx <= 0) return 0;

  // 1) impact angle gamma [rad], using downward speed magnitude
  const vyDown = Math.max(0, -landingVy);
  const gamma = Math.atan2(vyDown, Math.max(landingVx, EPSILON)); // 0=shallow, larger=steep

  // 2) make "roll start speed" v0 by damping with impact angle
  // v0 = vx / (1 + K * tan(gamma)^2)  (very stable, easy to tune)
  const K_ANGLE = 1; // 2..8 : bigger = steeper landing loses more speed
  const tanG = Math.tan(gamma);
  let v0 = landingVx / (1 + K_ANGLE * tanG * tanG);

  // extra safety clamps (prevents extreme carry/run when something upstream goes odd)
  v0 = clamp(v0, 0, landingVx);

  // 3) rolling resistance model params (turf)
  // a0 ~ constant loss (m/s^2), k ~ velocity-proportional loss (1/s)
  // Fairway-ish defaults (tune):
  const a0 = 1.2;     // 0.6..1.6  (bigger -> shorter run)
  const k  = 0.3;    // 0.10..0.35 (bigger -> shorter run)

  // 4) distance until stop for dv/dt = -(a0 + k v)
  // s = v0/k - (a0/k^2) * ln(1 + k v0/a0)
  const kvOverA0 = (k * v0) / Math.max(a0, EPSILON);
  const run = (v0 / Math.max(k, EPSILON)) - (a0 / Math.max(k * k, EPSILON)) * Math.log(1 + kvOverA0);

  // 5) final clamp (optional, but makes UI bulletproof)
  const RUN_MAX_METERS = 120; // ~131 yd cap (set as you like)
  return clamp(run, 0, RUN_MAX_METERS);
}

function computeRunWithBounceFromLanding(landingVx, landingVy, spinLandRpm) {
  const runPath = [{ x: 0, y: 0 }];

  if (!Number.isFinite(landingVx) || !Number.isFinite(landingVy) || landingVx <= 0) {
    return { runMeters: 0, runPath };
  }

  const g = GRAVITY;
  const eN = clamp(GROUND.eN, 0, 0.9);
  const bounceHorizLoss = 0.94;
  const maxBounceHeightMeters = 12;
  const minBounceVy = GROUND.vyStop;

  let vx = Math.max(landingVx, 0);
  let vyDown = Math.max(0, -landingVy);
  let x = 0;

  for (let i = 0; i < GROUND.maxBounces; i += 1) {
    const vyUp = vyDown * eN;
    if (vyUp < minBounceVy || vx <= 0) break;

    const tBounce = (2 * vyUp) / g;
    const bounceDist = vx * tBounce;
    x += Math.max(0, bounceDist);

    const peakHeight = clamp((vyUp * vyUp) / (2 * g), 0, maxBounceHeightMeters);
    runPath.push({ x: x - bounceDist / 2, y: peakHeight });
    runPath.push({ x, y: 0 });

    vx *= bounceHorizLoss;
    vyDown = vyUp;
  }

  const rollMeters = computeRunMetersFromLanding(vx, 0, spinLandRpm);
  const totalRunMeters = x + rollMeters;
  runPath.push({ x: totalRunMeters, y: 0 });

  return {
    runMeters: totalRunMeters,
    runPath,
  };
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

  const run = computeRunWithBounceFromLanding(
    flight.landingVx,
    flight.landingVy,
    spinLand
  );

  const runTrajectory = run.runPath.map((point) => ({
    x: flight.carryMeters + point.x,
    y: point.y,
  }));

  return {
    ballSpeed,
    carryMeters: flight.carryMeters,
    totalMeters: flight.carryMeters + run.runMeters,
    trajectory: flight.trajectory,
    runTrajectory,
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

function drawRunSegment(result, color, scaleX, scaleY, pad, groundY, maxDisplayMeters, alpha = 1) {
  if (!ctx || !canvas) return;

  const runTrajectory = result.runTrajectory || [
    { x: result.carryMeters, y: 0 },
    { x: result.totalMeters, y: 0 },
  ];

  if (runTrajectory.length < 2) return;

  const visiblePoints = runTrajectory
    .filter((point) => point.x <= maxDisplayMeters)
    .map((point) => ({
      x: pad + point.x * scaleX,
      y: groundY - point.y * scaleY,
    }));

  if (visiblePoints.length < 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(visiblePoints[0].x, visiblePoints[0].y - 1);
  for (let i = 1; i < visiblePoints.length; i += 1) {
    ctx.lineTo(visiblePoints[i].x, visiblePoints[i].y - 1);
  }
  ctx.stroke();

  const last = visiblePoints[visiblePoints.length - 1];
  if (result.totalMeters <= maxDisplayMeters) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last.x, groundY, 4, 0, Math.PI * 2);
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

  const baseDisplayMeters = computeMaxDisplayMeters(currentResult.totalMeters, previous?.totalMeters || 0);
  const maxHeightMeters = Math.max(Math.max(currentResult.maxHeightMeters, previous?.maxHeightMeters || 0) * 1.35, 1);
  const minDisplayForEqualScale = (width * maxHeightMeters) / height;
  const maxDisplayMeters = Math.max(baseDisplayMeters, minDisplayForEqualScale);

  const unifiedScale = width / maxDisplayMeters;
  const scaleX = unifiedScale;
  const scaleY = unifiedScale;

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
    drawRunSegment(previous, "#8ea0b4", scaleX, scaleY, pad, groundY, maxDisplayMeters, 0.45);
  }

  const currentMarks = drawSingleTrajectory(currentResult.trajectory, "#41a5ff", 3, 1, scaleX, scaleY, pad, groundY, maxDisplayMeters, "#ff3b30");
  drawRunSegment(currentResult, "#111", scaleX, scaleY, pad, groundY, maxDisplayMeters, 1);

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
    computeRunMetersFromLanding,
    computeRunWithBounceFromLanding,
  };
}
