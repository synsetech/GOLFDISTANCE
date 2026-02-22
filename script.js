const OPTIMAL_SPIN_RPM = 2500;

// --- Physics constants ---
const GRAVITY = 9.80665; // m/s^2
const AIR_DENSITY = 1.2; // kg/m^3
const BALL_MASS = 0.04593; // kg
const BALL_DIAMETER = 0.04267; // m
const BALL_RADIUS = BALL_DIAMETER / 2;
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;

// Kinematic viscosity of air (approx, 20°C)
const AIR_KINEMATIC_VISCOSITY = 1.5e-5; // m^2/s

// Spin decay default: 4% per second (as used in Lyu 2018 trajectory example)
const SPIN_DECAY_FRACTION_PER_SEC = 0.04;

// Ground run (simple)
const RUN_COEFFICIENT = 0.01;

// Units
const METERS_PER_YARD = 0.9144;

// Numerical safety
const EPSILON = 1e-6;

// --- DOM ---
const form = document.getElementById("distance-form");
const errorMessage = document.getElementById("error-message");
const carryResult = document.getElementById("carryResult");
const totalResult = document.getElementById("totalResult");
const canvas = document.getElementById("trajectoryCanvas");
const ctx = canvas.getContext("2d");

const headSpeedInput = document.getElementById("headSpeed");
const smashFactorInput = document.getElementById("smashFactor");
const launchAngleInput = document.getElementById("launchAngle");

const spinRateInput = document.getElementById("spinRate");
const spinDecayEnabledInput = document.getElementById("spinDecayEnabled");

const headSpeedValue = document.getElementById("headSpeedValue");
const smashFactorValue = document.getElementById("smashFactorValue");
const launchAngleValue = document.getElementById("launchAngleValue");
const spinRateValue = document.getElementById("spinRateValue");
const ballSpeedResult = document.getElementById("ballSpeedResult");
const maxHeightResult = document.getElementById("maxHeightResult");

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add("show");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.classList.remove("show");
}

function clamp(x, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, x));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// --- Aerodynamic models (from Lyu et al. 2018 figures) ---
// Cd(Re): piecewise quadratic fits shown for a spinning ball example (KK) in Fig.3(b).
function cdFromRe(re) {
  // Low-speed fit (50k < Re < 100k):
  // Cd = 1.29e-10 Re^2 - 2.59e-5 Re + 1.50
  const cdLow = 1.29e-10 * re * re - 2.59e-5 * re + 1.50;

  // High-speed fit (75k < Re < 200k):
  // Cd = 1.91e-11 Re^2 - 5.40e-6 Re + 0.56
  const cdHigh = 1.91e-11 * re * re - 5.40e-6 * re + 0.56;

  // Smooth blend between 75k and 100k to avoid a kink
  const reBlendStart = 75000;
  const reBlendEnd = 100000;

  if (re <= reBlendStart) return cdLow;
  if (re >= reBlendEnd) return cdHigh;

  const t = (re - reBlendStart) / (reBlendEnd - reBlendStart);
  return lerp(cdLow, cdHigh, t);
}

// Cl(S): quadratic fit shown for KK in Fig.4(b):
// Cl = -3.25 S^2 + 1.99 S
function clFromSpinFactor(s) {
  const cl = -3.25 * s * s + 1.99 * s;
  // Physical clamp: no negative lift in this simplified model
  return Math.max(0, cl);
}

// Spin factor S = ω r / V (ω in rad/s)
function spinFactorFrom(speed, spinRpm) {
  const omega = (spinRpm * 2 * Math.PI) / 60; // rad/s
  return (omega * BALL_RADIUS) / Math.max(speed, EPSILON);
}

// Exponential spin decay equivalent to “4%/s” multiplicative decay
// spin(t) = spin0 * (1 - k)^t  ≈ spin0 * exp( -k t ) for small k
function spinAtTime(spin0Rpm, tSec, enabled) {
  if (!enabled) return spin0Rpm;
  // Use exponential approximation for smoothness
  return spin0Rpm * Math.exp(-SPIN_DECAY_FRACTION_PER_SEC * tSec);
}

function updateOutputs() {
  headSpeedValue.textContent = Number(headSpeedInput.value).toFixed(1);
  smashFactorValue.textContent = Number(smashFactorInput.value).toFixed(2);
  launchAngleValue.textContent = `${Number(launchAngleInput.value).toFixed(1)}°`;

  if (spinRateInput && spinRateValue) {
    spinRateValue.textContent = `${Number(spinRateInput.value).toFixed(0)}`;
  }
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

function simulateFlight(ballSpeed, launchAngleDeg, spinRpm, spinDecayEnabled) {
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

  let t = 0;

  for (let i = 0; i < 3000; i += 1) {
    const previous = { ...state };
    const speed = Math.max(Math.hypot(state.vx, state.vy), EPSILON);

    // --- Re-dependent drag coefficient ---
    const re = (speed * BALL_DIAMETER) / AIR_KINEMATIC_VISCOSITY;
    // Keep model in the range it was fit around (roughly 50k–200k). Outside: clamp.
    const reClamped = clamp(re, 50000, 200000);
    const cd = cdFromRe(reClamped);

    // --- Spin-dependent lift coefficient ---
    const currentSpinRpm = spinAtTime(spinRpm, t, spinDecayEnabled);
    const s = spinFactorFrom(speed, currentSpinRpm);
    const cl = clFromSpinFactor(s);

    const dragForce = 0.5 * AIR_DENSITY * cd * BALL_AREA * speed * speed;
    const liftForce = 0.5 * AIR_DENSITY * cl * BALL_AREA * speed * speed;

    // Accelerations
    const ax = (-dragForce * state.vx / speed - liftForce * state.vy / speed) / BALL_MASS;

    const ay =
      -GRAVITY +
      (-dragForce * state.vy / speed + liftForce * state.vx / speed) /
        BALL_MASS;

    state.vx += ax * dt;
    state.vy += ay * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;

    maxHeight = Math.max(maxHeight, state.y);

    if (state.y < 0) {
      landingState = interpolateAtGround(previous, state);
      trajectory.push({ x: landingState.x, y: 0 });
      break;
    }

    trajectory.push({ x: state.x, y: state.y });
    landingState = { ...state };

    t += dt;
  }

  const carryMeters = Math.max(landingState.x, 0);

  return {
    carryMeters,
    maxHeightMeters: Math.max(maxHeight, 0),
    landingVx: landingState.vx,
    landingVy: landingState.vy,
    trajectory,
  };
}

function calculateDistances(headSpeed, smashFactor, launchAngleDeg, spinRpm, spinDecayEnabled) {
  const ballSpeed = headSpeed * smashFactor;
  const flight = simulateFlight(ballSpeed, launchAngleDeg, spinRpm, spinDecayEnabled);

  const gamma = Math.atan(Math.abs(flight.landingVy) / Math.max(flight.landingVx, EPSILON));

  const runMeters = Math.max(0, RUN_COEFFICIENT * flight.landingVx * flight.landingVx * Math.cos(gamma));

  return {
    ballSpeed,
    carryMeters: flight.carryMeters,
    totalMeters: flight.carryMeters + runMeters,
    trajectory: flight.trajectory,
    maxHeightMeters: flight.maxHeightMeters,
  };
}

function validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw, spinRateRaw) {
  if (!headSpeedRaw || !smashFactorRaw || !launchAngleRaw || !spinRateRaw) {
    return "すべての入力欄を入力してください。";
  }

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);
  const spinRate = Number(spinRateRaw);

  if (!Number.isFinite(headSpeed) || !Number.isFinite(smashFactor) || !Number.isFinite(launchAngle) || !Number.isFinite(spinRate)) {
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

  if (launchAngle < 5 || launchAngle > 25) {
    return "打ち出し角度は 5.0〜25.0 度の範囲で入力してください。";
  }

  // Match paper range used for spin-factor fit context: 1500–4500 rpm
  if (spinRate < 1500 || spinRate > 3000) {
    return "スピンレートは 1500〜3000 rpm の範囲で入力してください。";
  }

  return null;
}

function drawTrajectory(trajectory, maxHeightMeters) {
  const pad = 36;
  const groundY = canvas.height - pad;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#4f6580";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, groundY);
  ctx.lineTo(canvas.width - pad, groundY);
  ctx.stroke();

  const carryMeters = trajectory[trajectory.length - 1]?.x ?? 1;

  const width = canvas.width - pad * 2;
  const height = canvas.height - pad * 2;

  const scaleX = width / Math.max(carryMeters, 1);
  const scaleY = height / Math.max(maxHeightMeters * 1.35, 1);

  ctx.strokeStyle = "#1266f1";
  ctx.lineWidth = 3;
  ctx.beginPath();

  let peakPoint = { x: pad, y: groundY };

  trajectory.forEach((point, index) => {
    const px = pad + point.x * scaleX;
    const py = groundY - point.y * scaleY;

    if (index === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }

    if (py < peakPoint.y) {
      peakPoint = { x: px, y: py };
    }
  });

  ctx.stroke();

  const landingX = pad + carryMeters * scaleX;

  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.arc(landingX, groundY, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f57c00";
  ctx.beginPath();
  ctx.arc(peakPoint.x, peakPoint.y, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1e2a38";
  ctx.font = "14px sans-serif";
  ctx.fillText("着弾点", landingX - 18, groundY - 10);
  ctx.fillText("最高到達点", peakPoint.x - 32, peakPoint.y - 10);
  ctx.fillText("X軸: 距離", canvas.width - 110, groundY - 8);
  ctx.fillText("Y軸: 高さ", pad + 2, pad - 10);
}

[headSpeedInput, smashFactorInput, launchAngleInput, spinRateInput].forEach((input) => {
  if (!input) return;
  input.addEventListener("input", updateOutputs);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const headSpeedRaw = headSpeedInput.value.trim();
  const smashFactorRaw = smashFactorInput.value.trim();
  const launchAngleRaw = launchAngleInput.value.trim();
  const spinRateRaw = (spinRateInput?.value ?? "").toString().trim();

  const error = validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw, spinRateRaw);

  if (error) {
    showError(error);
    ballSpeedResult.textContent = "-";
    maxHeightResult.textContent = "-";
    carryResult.textContent = "-";
    totalResult.textContent = "-";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  clearError();

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);
  const spinRate = Number(spinRateRaw);
  const spinDecayEnabled = !!spinDecayEnabledInput?.checked;

  const result = calculateDistances(headSpeed, smashFactor, launchAngle, spinRate, spinDecayEnabled);

  const carryYd = result.carryMeters / METERS_PER_YARD;
  const totalYd = result.totalMeters / METERS_PER_YARD;

  ballSpeedResult.textContent = `${result.ballSpeed.toFixed(1)} m/s`;
  maxHeightResult.textContent = `${result.maxHeightMeters.toFixed(1)} m`;
  carryResult.textContent = `${result.carryMeters.toFixed(1)} m / ${carryYd.toFixed(1)} yd`;

  totalResult.textContent = `${result.totalMeters.toFixed(1)} m / ${totalYd.toFixed(1)} yd`;

  drawTrajectory(result.trajectory, result.maxHeightMeters);
});

updateOutputs();
console.info(`Spin slider enabled. Default: ${OPTIMAL_SPIN_RPM} rpm`);
