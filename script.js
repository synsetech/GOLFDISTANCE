const OPTIMAL_SPIN_RPM = 2500;
const GRAVITY = 9.80665;
const AIR_DENSITY = 1.2;
const BALL_MASS = 0.04593;
const BALL_DIAMETER = 0.04267;
const BALL_RADIUS = BALL_DIAMETER / 2;
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const AIR_KINEMATIC_VISCOSITY = 1.5e-5;
const RUN_COEFFICIENT = 0.01;
const METERS_PER_YARD = 0.9144;
const EPSILON = 1e-6;

const form = document.getElementById("distance-form");
const errorMessage = document.getElementById("error-message");
const carryResult = document.getElementById("carryResult");
const totalResult = document.getElementById("totalResult");
const ballSpeedResult = document.getElementById("ballSpeedResult");
const maxHeightResult = document.getElementById("maxHeightResult");
const canvas = document.getElementById("trajectoryCanvas");
const ctx = canvas.getContext("2d");

const headSpeedInput = document.getElementById("headSpeed");
const smashFactorInput = document.getElementById("smashFactor");
const launchAngleInput = document.getElementById("launchAngle");
const headSpeedValue = document.getElementById("headSpeedValue");
const smashFactorValue = document.getElementById("smashFactorValue");
const launchAngleValue = document.getElementById("launchAngleValue");

let previousResult = null;

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

function updateOutputs() {
  headSpeedValue.textContent = Number(headSpeedInput.value).toFixed(1);
  smashFactorValue.textContent = Number(smashFactorInput.value).toFixed(2);
  launchAngleValue.textContent = `${Number(launchAngleInput.value).toFixed(1)}°`;
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

function simulateFlight(ballSpeed, launchAngleDeg) {
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

  for (let i = 0; i < 3000; i += 1) {
    const previous = { ...state };
    const speed = Math.max(Math.hypot(state.vx, state.vy), EPSILON);
    const re = (speed * BALL_DIAMETER) / AIR_KINEMATIC_VISCOSITY;
    const reClamped = clamp(re, 50000, 200000);

    const cd = cdFromRe(reClamped);
    const spinFactor = spinFactorFrom(speed, OPTIMAL_SPIN_RPM);
    const cl = clFromSpinFactor(spinFactor);

    const dragForce = 0.5 * AIR_DENSITY * cd * BALL_AREA * speed * speed;
    const liftForce = 0.5 * AIR_DENSITY * cl * BALL_AREA * speed * speed;

    const ax = (-dragForce * state.vx / speed - liftForce * state.vy / speed) / BALL_MASS;
    const ay = -GRAVITY + (-dragForce * state.vy / speed + liftForce * state.vx / speed) / BALL_MASS;

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
  }

  return {
    carryMeters: Math.max(landingState.x, 0),
    maxHeightMeters: Math.max(maxHeight, 0),
    landingVx: landingState.vx,
    landingVy: landingState.vy,
    trajectory,
  };
}

function calculateDistances(headSpeed, smashFactor, launchAngleDeg) {
  const ballSpeed = headSpeed * smashFactor;
  const flight = simulateFlight(ballSpeed, launchAngleDeg);
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

function validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw) {
  if (!headSpeedRaw || !smashFactorRaw || !launchAngleRaw) {
    return "すべての入力欄を入力してください。";
  }

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);

  if (!Number.isFinite(headSpeed) || !Number.isFinite(smashFactor) || !Number.isFinite(launchAngle)) {
    return "数値形式で入力してください。";
  }

  if (headSpeed <= 0 || smashFactor <= 0 || launchAngle <= 0) {
    return "0より大きい値を入力してください。";
  }

  if (headSpeed < 25 || headSpeed > 60) {
    return "ヘッドスピードは 25.0〜60.0 の範囲で入力してください。";
  }

  if (smashFactor < 1.3 || smashFactor > 1.56) {
    return "ミート率は 1.30〜1.56 の範囲で入力してください。";
  }

  if (launchAngle < 10 || launchAngle > 18) {
    return "ローンチアングルは 10.0〜18.0 度の範囲で入力してください。";
  }

  return null;
}

function drawSingleTrajectory(trajectory, maxHeightMeters, color, lineWidth, alpha) {
  const pad = 36;
  const groundY = canvas.height - pad;
  const carryMeters = trajectory[trajectory.length - 1]?.x ?? 1;
  const width = canvas.width - pad * 2;
  const height = canvas.height - pad * 2;
  const scaleX = width / Math.max(carryMeters, 1);
  const scaleY = height / Math.max(maxHeightMeters * 1.35, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
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
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(landingX, groundY, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(peakPoint.x, peakPoint.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return { landingX, peakPoint };
}

function drawTrajectory(currentResult, previous) {
  const pad = 36;
  const groundY = canvas.height - pad;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#4f6580";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, groundY);
  ctx.lineTo(canvas.width - pad, groundY);
  ctx.stroke();

  if (previous) {
    drawSingleTrajectory(previous.trajectory, previous.maxHeightMeters, "#7f8c9b", 2, 0.35);
  }

  const currentMarks = drawSingleTrajectory(currentResult.trajectory, currentResult.maxHeightMeters, "#1266f1", 3, 1);

  ctx.fillStyle = "#1e2a38";
  ctx.font = "14px sans-serif";
  ctx.fillText("着弾点", currentMarks.landingX - 18, groundY - 10);
  ctx.fillText("最高到達点", currentMarks.peakPoint.x - 32, currentMarks.peakPoint.y - 10);
  ctx.fillText("X軸: 距離", canvas.width - 110, groundY - 8);
  ctx.fillText("Y軸: 高さ", pad + 2, pad - 10);
}

[headSpeedInput, smashFactorInput, launchAngleInput].forEach((input) => {
  input.addEventListener("input", updateOutputs);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const headSpeedRaw = headSpeedInput.value.trim();
  const smashFactorRaw = smashFactorInput.value.trim();
  const launchAngleRaw = launchAngleInput.value.trim();

  const error = validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw);

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

  const result = calculateDistances(Number(headSpeedRaw), Number(smashFactorRaw), Number(launchAngleRaw));

  const carryYd = result.carryMeters / METERS_PER_YARD;
  const totalYd = result.totalMeters / METERS_PER_YARD;

  ballSpeedResult.textContent = `${result.ballSpeed.toFixed(1)} m/s`;
  maxHeightResult.textContent = `${result.maxHeightMeters.toFixed(1)} m`;
  carryResult.textContent = `${result.carryMeters.toFixed(1)} m / ${carryYd.toFixed(1)} yd`;
  totalResult.textContent = `${result.totalMeters.toFixed(1)} m / ${totalYd.toFixed(1)} yd`;

  drawTrajectory(result, previousResult);
  previousResult = result;
});

updateOutputs();
console.info(`固定スピン設定: ${OPTIMAL_SPIN_RPM} rpm`);
