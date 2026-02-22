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
const DISPLAY_PADDING_YARDS = 20;

const GROUND = {
  // First impact: 地面が潰れる前提で低め
  eNFirst: 0.22,
  // 2回目以降のバウンド反発
  eNAfter: 0.36,
  // Kinetic friction coefficient during impact + sliding
  mu: 0.35,          // (将来拡張用: 今回のバウンド減衰では未使用)
  // Rolling resistance coefficient (pure rolling decel = cRR * g)
  cRR: 0.030,        // fairway 0.020..0.040, rough 0.050..0.080
  // Stop bouncing when post-bounce vertical speed is below this
  vyStop: 0.55,      // m/s
  // Safety limit
  maxBounces: 4,
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
  const paddedMeters = maxTotalMeters + DISPLAY_PADDING_YARDS * METERS_PER_YARD;
  return Math.max(paddedMeters, 150 * METERS_PER_YARD);
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

  // 3) rolling run model: Vx^2 dependent
  // run = k * v0^2 （入射角で減衰した v0 を使用）
  const K_RUN_VX2 = 0.085;
  const run = K_RUN_VX2 * v0 * v0;

  // 4) final clamp (optional, but makes UI bulletproof)
  const RUN_MAX_METERS = 120; // ~131 yd cap (set as you like)
  return clamp(run, 0, RUN_MAX_METERS);
}

function computeRunWithBounceFromLanding(landingVx, landingVy, spinLandRpm) {
  const runPath = [{ x: 0, y: 0 }];

  if (!Number.isFinite(landingVx) || !Number.isFinite(landingVy) || landingVx <= 0) {
    return { runMeters: 0, runPath };
  }

  const g = GRAVITY;
  const eNFirst = clamp(GROUND.eNFirst, 0, 0.9);
  const eNAfter = clamp(GROUND.eNAfter, 0, 0.9);
  const maxBounceHeightMeters = 8;
  const minBounceVy = GROUND.vyStop;

  const vyDownAtLanding = Math.max(0, -landingVy);
  const gamma = Math.atan2(vyDownAtLanding, Math.max(landingVx, EPSILON));
  const K_LANDING_ANGLE = 1.1;
  const tanG = Math.tan(gamma);
  const landingAngleLoss = 1 / (1 + K_LANDING_ANGLE * tanG * tanG);

  // 1回目着弾のみ: Backspin(+)で減衰強め / Topspin(-)で減衰弱め
  const spinSign = Math.sign(spinLandRpm || 0);
  const spinAbs = Math.abs(spinLandRpm || 0);
  const spinNorm = clamp(spinAbs / 3200, 0, 2.0);
  const spinLoss = clamp(1 - 0.22 * spinNorm * spinSign, 0.72, 1.00);

  let vx = Math.max(landingVx * landingAngleLoss * spinLoss, 0);
  let vyDown = vyDownAtLanding;
  let x = 0;

  for (let i = 0; i < GROUND.maxBounces; i += 1) {
    const eN = i === 0 ? eNFirst : eNAfter;
    const vyUp = vyDown * eN;
    if (vyUp < minBounceVy || vx <= 0) break;

    const tBounce = (2 * vyUp) / g;
    const sampleCount = clamp(Math.ceil(tBounce / 0.015), 4, 24);

    for (let s = 1; s <= sampleCount; s += 1) {
      const t = (tBounce * s) / sampleCount;
      const px = x + vx * t;
      const py = Math.max(0, vyUp * t - 0.5 * g * t * t);
      runPath.push({ x: px, y: py });
    }

    const bounceDist = vx * tBounce;
    x += Math.max(0, bounceDist);

    // 水平方向は摩擦式で毎回減衰させず、着弾時の入射角で初期減衰させる
    vyDown = vyUp;

    const peakHeight = clamp((vyUp * vyUp) / (2 * g), 0, maxBounceHeightMeters);
    if (peakHeight <= 0.01) break;
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

  if (launchAngle < 8 || launchAngle > 25) {
    return "打ち出し角は 8.0〜25.0 度の範囲で入力してください。";
  }

  if (spinRate < 1500 || spinRate > 5000) {
    return "スピンレートは 1500〜5000 rpm の範囲で入力してください。";
  }

  if (windSpeed < -10 || windSpeed > 10) {
    return "風向風速は -10.0〜10.0 m/s の範囲で入力してください。";
  }

  return null;
}

function drawSingleTrajectory(trajectory, color, lineWidth, alpha, scaleX, scaleY, plotLeft, plotTop, plotBottom, maxDisplayMeters, opts = {}) {
  if (!ctx || !canvas) return { landingX: plotLeft, peakPoint: { x: plotLeft, y: plotBottom }, overflow: false };

  const {
    showLandingMarker = true,
    showPeakMarker = true,
    peakMarkerColor = "#ff3b30",
  } = opts;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  ctx.beginPath();

  let started = false;
  let peakPoint = { x: plotLeft, y: plotBottom };
  let clippedAtEdge = false;

  for (const point of trajectory) {
    if (point.x > maxDisplayMeters) {
      clippedAtEdge = true;
      break;
    }

    const px = plotLeft + point.x * scaleX;
    const py = plotBottom - point.y * scaleY;

    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }

    if (py < peakPoint.y) peakPoint = { x: px, y: py };
  }

  if (clippedAtEdge && trajectory.length >= 2) {
    let prev = null;
    let next = null;

    for (let i = trajectory.length - 1; i >= 0; i -= 1) {
      if (trajectory[i].x <= maxDisplayMeters) {
        prev = trajectory[i];
        break;
      }
    }
    for (let i = 0; i < trajectory.length; i += 1) {
      if (trajectory[i].x > maxDisplayMeters) {
        next = trajectory[i];
        break;
      }
    }

    if (prev && next) {
      const t = (maxDisplayMeters - prev.x) / Math.max(next.x - prev.x, EPSILON);
      const yAtEdge = prev.y + (next.y - prev.y) * t;
      const pxEdge = plotLeft + maxDisplayMeters * scaleX;
      const pyEdge = plotBottom - yAtEdge * scaleY;
      ctx.lineTo(pxEdge, pyEdge);
      if (pyEdge < peakPoint.y) peakPoint = { x: pxEdge, y: pyEdge };
    }
  }

  ctx.stroke();

  const carryMeters = trajectory[trajectory.length - 1]?.x ?? 0;
  const overflow = carryMeters > maxDisplayMeters;
  const landingX = overflow ? (plotLeft + maxDisplayMeters * scaleX) : (plotLeft + carryMeters * scaleX);

  if (showLandingMarker && !overflow) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(landingX, plotBottom, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (showPeakMarker) {
    ctx.fillStyle = peakMarkerColor;
    ctx.beginPath();
    ctx.arc(peakPoint.x, peakPoint.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  return { landingX, peakPoint, overflow };
}

function drawRunSegment(result, color, scaleX, plotLeft, plotBottom, maxDisplayMeters, alpha = 1) {
  if (!ctx || !canvas) return;

  const runTrajectory = result.runTrajectory || [
    { x: result.carryMeters, y: 0 },
    { x: result.totalMeters, y: 0 },
  ];

  if (runTrajectory.length < 2) return;

  const visiblePoints = runTrajectory
    .filter((point) => point.x <= maxDisplayMeters)
    .map((point) => ({
      x: plotLeft + point.x * scaleX,
      y: plotBottom - point.y * scaleX,
    }));

  if (visiblePoints.length < 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([]);
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
    ctx.arc(last.x, plotBottom, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawTrajectory(currentResult, previous) {
  if (!ctx || !canvas) return;

  const margin = {
    left: 18,
    right: 18,
    top: 12,
    bottom: 36,
  };

  const plotLeft = margin.left;
  const plotRight = canvas.width - margin.right;
  const plotTop = margin.top;
  const plotBottom = canvas.height - margin.bottom;

  const width = plotRight - plotLeft;
  const height = plotBottom - plotTop;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.fillStyle = "#f5f7fb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  const baseDisplayMeters = computeMaxDisplayMeters(currentResult.totalMeters, previous?.totalMeters || 0);
  const maxHeightMeters = Math.max(
    Math.max(currentResult.maxHeightMeters, previous?.maxHeightMeters || 0) * 1.18,
    1
  );

  // 縦横ヤード軸の等倍を厳守
  const unifiedScale = Math.min(
    width / Math.max(baseDisplayMeters, EPSILON),
    height / Math.max(maxHeightMeters, EPSILON)
  );

  const maxDisplayMeters = width / Math.max(unifiedScale, EPSILON);
  const maxDisplayYMeters = height / Math.max(unifiedScale, EPSILON);
  const scaleX = unifiedScale;
  const scaleY = unifiedScale;

  ctx.save();
  ctx.strokeStyle = "rgba(50, 60, 80, 0.26)";
  ctx.lineWidth = 1;
  ctx.strokeRect(plotLeft, plotTop, width, height);
  ctx.restore();

  const majorYd = 50;
  const minorYd = 10;
  const maxDisplayYardsX = Math.floor(maxDisplayMeters / METERS_PER_YARD);
  const maxDisplayYardsY = Math.floor(maxDisplayYMeters / METERS_PER_YARD);

  // minor grid (縦横)
  ctx.save();
  ctx.strokeStyle = "rgba(40, 45, 55, 0.10)";
  ctx.lineWidth = 1;
  for (let yd = minorYd; yd <= maxDisplayYardsX; yd += minorYd) {
    if (yd % majorYd === 0) continue;
    const x = plotLeft + yd * METERS_PER_YARD * scaleX;
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotTop);
    ctx.stroke();
  }
  for (let yd = minorYd; yd <= maxDisplayYardsY; yd += minorYd) {
    if (yd % majorYd === 0) continue;
    const y = plotBottom - yd * METERS_PER_YARD * scaleY;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }
  ctx.restore();

  // major grid + labels (black text)
  ctx.save();
  ctx.strokeStyle = "rgba(20, 25, 35, 0.22)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#12161f";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";

  for (let yd = majorYd; yd <= maxDisplayYardsX; yd += majorYd) {
    const x = plotLeft + yd * METERS_PER_YARD * scaleX;
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotTop);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotBottom - 9);
    ctx.stroke();

    const label = `${yd}`;
    const w = ctx.measureText(label).width;
    ctx.fillText(label, x - w / 2, plotBottom + 18);
  }

  for (let yd = majorYd; yd <= maxDisplayYardsY; yd += majorYd) {
    const y = plotBottom - yd * METERS_PER_YARD * scaleY;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();

    const label = `${yd}`;
    ctx.fillText(label, plotLeft - 14, y + 4);
  }

  ctx.fillText("X [yd]", plotRight - 42, canvas.height - 10);
  ctx.fillText("Y [yd]", plotLeft + 4, plotTop + 14);
  ctx.restore();

  // baseline
  ctx.save();
  ctx.strokeStyle = "rgba(20, 25, 35, 0.50)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();
  ctx.restore();

  if (previous) {
    drawSingleTrajectory(
      previous.trajectory,
      "rgba(90, 105, 125, 0.72)",
      2,
      0.55,
      scaleX,
      scaleY,
      plotLeft,
      plotTop,
      plotBottom,
      maxDisplayMeters,
      { showLandingMarker: true, showPeakMarker: true, peakMarkerColor: "rgba(190, 80, 80, 0.85)" }
    );
    drawRunSegment(previous, "rgba(90, 105, 125, 0.72)", scaleX, plotLeft, plotBottom, maxDisplayMeters, 0.55);
  }

  const currentMarks = drawSingleTrajectory(
    currentResult.trajectory,
    "rgba(20, 130, 245, 1)",
    3,
    1,
    scaleX,
    scaleY,
    plotLeft,
    plotTop,
    plotBottom,
    maxDisplayMeters,
    { showLandingMarker: true, showPeakMarker: true, peakMarkerColor: "rgba(220, 40, 40, 1)" }
  );

  drawRunSegment(currentResult, "rgba(20,20,20,0.92)", scaleX, plotLeft, plotBottom, maxDisplayMeters, 1);

  ctx.save();
  ctx.fillStyle = "#111";
  ctx.font = "13px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("Landing", clamp(currentMarks.landingX - 18, plotLeft + 2, plotRight - 74), clamp(plotBottom - 12, plotTop + 16, plotBottom - 6));
  ctx.fillText("Apex", clamp(currentMarks.peakPoint.x - 20, plotLeft + 2, plotRight - 60), clamp(currentMarks.peakPoint.y - 10, plotTop + 16, plotBottom - 20));
  ctx.restore();
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
