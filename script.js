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
  eNFirst: 0.3,
  eNAfter: 0.36,
  eTFirst: 0.78,
  eTAfter: 0.86,
  vyStop: 0.55,
  maxBounces: 6,
};

const SPIN_DECAY_RATE = 0.04;
const CD_SPIN_LINEAR = 0.35;

function getSimulationConfig() {
  const mode = typeof document !== "undefined" ? document.body?.dataset?.mode : null;
  if (mode === "middle-iron") {
    return {
      headSpeed: { min: 15, max: 45 },
      smashFactor: { min: 1.1, max: 1.5 },
      launchAngle: { min: 12, max: 40 },
      spinRate: { min: 3000, max: 10000 },
      windSpeed: { min: -7, max: 7 },
    };
  }

  return {
    headSpeed: { min: 30, max: 60 },
    smashFactor: { min: 1.3, max: 1.56 },
    launchAngle: { min: 8, max: 25 },
    spinRate: { min: 1500, max: 4000 },
    windSpeed: { min: -7, max: 7 },
  };
}


function computeWindDisplayValue(rawWindValue) {
  return -rawWindValue;
}

function toPhysicsWind(rawWindValue) {
  return -rawWindValue;
}

function getDisplayConfig() {
  const mode = typeof document !== "undefined" ? document.body?.dataset?.mode : null;
  if (mode === "middle-iron") {
    return {
      minDisplayXards: 15,
      maxDisplayYards: 100,
    };
  }

  return {
    minDisplayXards: 30,
    maxDisplayYards: 100,
  };
}

function computeMaxDisplayMeters(...totalMetersList) {
  const maxTotalMeters = Math.max(...totalMetersList.map((v) => v || 0), 0);
  const paddedMeters = maxTotalMeters + DISPLAY_PADDING_YARDS * METERS_PER_YARD;
  const displayConfig = getDisplayConfig();
  return Math.max(paddedMeters, displayConfig.minDisplayXards * METERS_PER_YARD);
}

function computeMaxDisplayYMeters(maxDisplayMeters, plotWidthPx, plotHeightPx) {
  const aspect = plotHeightPx / Math.max(plotWidthPx, EPSILON);
  const aspectLockedYMeters = maxDisplayMeters * aspect;
  const displayConfig = getDisplayConfig();
  return Math.min(aspectLockedYMeters, displayConfig.maxDisplayYards * METERS_PER_YARD);
}

const hasDom = typeof document !== "undefined";
const canvas = hasDom ? document.getElementById("trajectoryCanvas") : null;
const ctx = canvas ? canvas.getContext("2d") : null;

let previousResult = null;
let currentResult = null;

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
  const sClamped = Math.max(0, s);
  const clMax = 1.35;
  const liftBuildRate = 1.25;
  return clMax * (1 - Math.exp(-liftBuildRate * sClamped));
}

function spinFactorFrom(speed, spinRpm) {
  const omega = (spinRpm * 2 * Math.PI) / 60;
  return (omega * BALL_RADIUS) / Math.max(speed, EPSILON);
}

function updateWindSliderIndicator(windSpeedInput) {
  const min = Number(windSpeedInput.min);
  const max = Number(windSpeedInput.max);
  const rawVal = Number(windSpeedInput.value);
  const centerPct = ((0 - min) / (max - min)) * 100;
  const valPct = ((rawVal - min) / (max - min)) * 100;

  const neutral = "#cfd8e3";
  const tailwind = "#ff6c61";
  const headwind = "#3f8fff";

  if (Math.abs(rawVal) < 1e-9) {
    windSpeedInput.style.background = `linear-gradient(to right, ${neutral} 0%, ${neutral} 100%)`;
    return;
  }

  const from = Math.min(centerPct, valPct);
  const to = Math.max(centerPct, valPct);
  const activeColor = rawVal > 0 ? tailwind : headwind;

  windSpeedInput.style.background = `linear-gradient(to right, ${neutral} 0%, ${neutral} ${from}%, ${activeColor} ${from}%, ${activeColor} ${to}%, ${neutral} ${to}%, ${neutral} 100%)`;
}

function effectiveSpinRate(spinRate) {
  return Math.max(spinRate, 0);
}

function spinAtTimeRpm(spin0Rpm, tSec) {
  return spin0Rpm * Math.exp(-SPIN_DECAY_RATE * tSec);
}

function computeRunMetersFromLanding(landingVx, _landingVyIgnored, _spinLandRpmIgnored) {
  if (!Number.isFinite(landingVx)) return 0;

  const RUN_VX2_COEFF = 0.3788590963203658;
  let run = RUN_VX2_COEFF * landingVx * Math.abs(landingVx);

  const RUN_MAX_METERS = 120;
  run = clamp(run, -RUN_MAX_METERS, RUN_MAX_METERS);
  return run;
}

function computeRunWithBounceFromLanding(landingVx, landingVy, spinLandRpm) {
  const runPath = [{ x: 0, y: 0 }];

  if (!Number.isFinite(landingVx) || !Number.isFinite(landingVy) || landingVx <= 0) {
    return { runMeters: 0, runPath };
  }

  const g = GRAVITY;
  const eNFirst = clamp(GROUND.eNFirst, 0, 0.9);
  const eNAfter = clamp(GROUND.eNAfter, 0, 0.9);
  const eTFirst = clamp(GROUND.eTFirst ?? 0.78, 0.4, 0.99);
  const eTAfter = clamp(GROUND.eTAfter ?? 0.86, 0.4, 0.99);
  const maxBounceHeightMeters = 8;
  const minBounceVy = GROUND.vyStop;

  const vyDownAtLanding = Math.max(0, -landingVy);
  const gamma = Math.atan2(vyDownAtLanding, Math.max(landingVx, EPSILON));
  const K_LANDING_ANGLE = 1.1;
  const tanG = Math.tan(gamma);
  const landingAngleLoss = 1 / (1 + K_LANDING_ANGLE * tanG * tanG);

  let vx = landingVx * landingAngleLoss;

  const omega = ((spinLandRpm || 0) * 2 * Math.PI) / 60;
  const spinSurfaceSpeed = omega * BALL_RADIUS;
  const SPIN_IMPACT_GAIN = 0.22;
  vx -= SPIN_IMPACT_GAIN * spinSurfaceSpeed;

  const spinSign = Math.sign(spinLandRpm || 0);
  const spinAbs = Math.abs(spinLandRpm || 0);
  const spinNorm = clamp(spinAbs / 3500, 0, 1.5);
  const SPIN_ET_GAIN = 0.06;
  const eTFirstEff = clamp(
    eTFirst * (1 - SPIN_ET_GAIN * spinNorm * spinSign),
    0.55,
    0.95
  );

  let vyDown = vyDownAtLanding;
  let x = 0;

  for (let i = 0; i < GROUND.maxBounces; i += 1) {
    const eN = i === 0 ? eNFirst : eNAfter;

    vx *= (i === 0 ? eTFirstEff : eTAfter);

    const vyUp = vyDown * eN;
    if (vyUp < minBounceVy || Math.abs(vx) <= EPSILON) break;

    const tBounce = (2 * vyUp) / g;
    const sampleCount = clamp(Math.ceil(tBounce / 0.015), 4, 24);

    for (let s = 1; s <= sampleCount; s += 1) {
      const t = (tBounce * s) / sampleCount;
      const px = x + vx * t;
      const py = Math.max(0, vyUp * t - 0.5 * g * t * t);
      runPath.push({ x: px, y: py });
    }

    x += vx * tBounce;
    vyDown = vyUp;

    const peakHeight = clamp((vyUp * vyUp) / (2 * g), 0, maxBounceHeightMeters);
    if (peakHeight <= 0.01) break;
  }

  const rollMeters = computeRunMetersFromLanding(vx, 0, spinLandRpm);
  const totalRunMeters = x + rollMeters;
  runPath.push({ x: totalRunMeters, y: 0 });

  return { runMeters: totalRunMeters, runPath };
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

  const run = computeRunWithBounceFromLanding(flight.landingVx, flight.landingVy, spinLand);
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

  const simConfig = getSimulationConfig();

  if (headSpeed < simConfig.headSpeed.min || headSpeed > simConfig.headSpeed.max) return `ヘッドスピードは ${simConfig.headSpeed.min.toFixed(1)}〜${simConfig.headSpeed.max.toFixed(1)} の範囲で入力してください。`;
  if (smashFactor < simConfig.smashFactor.min || smashFactor > simConfig.smashFactor.max) return `ミート率は ${simConfig.smashFactor.min.toFixed(2)}〜${simConfig.smashFactor.max.toFixed(2)} の範囲で入力してください。`;
  if (launchAngle < simConfig.launchAngle.min || launchAngle > simConfig.launchAngle.max) return `打ち出し角は ${simConfig.launchAngle.min.toFixed(1)}〜${simConfig.launchAngle.max.toFixed(1)} 度の範囲で入力してください。`;
  if (spinRate < simConfig.spinRate.min || spinRate > simConfig.spinRate.max) return `スピンレートは ${simConfig.spinRate.min}〜${simConfig.spinRate.max} rpm の範囲で入力してください。`;
  if (windSpeed < simConfig.windSpeed.min || windSpeed > simConfig.windSpeed.max) return `風向風速は ${simConfig.windSpeed.min.toFixed(1)}〜+${simConfig.windSpeed.max.toFixed(1)} m/s の範囲で入力してください。`;

  return null;
}

function drawSingleTrajectory(result, color, scaleX, scaleY, plotLeft, plotBottom, maxDisplayMeters) {
  if (!ctx || !canvas || !result) return null;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();

  let peakPoint = { x: plotLeft, y: plotBottom };
  let started = false;

  for (const point of result.trajectory) {
    if (point.x > maxDisplayMeters) break;
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
  ctx.stroke();

  const runTrajectory = result.runTrajectory || [];
  if (runTrajectory.length > 1) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    let runStarted = false;
    for (const point of runTrajectory) {
      if (point.x > maxDisplayMeters) break;
      const px = plotLeft + point.x * scaleX;
      const py = plotBottom - point.y * scaleY;
      if (!runStarted) {
        ctx.moveTo(px, py - 1);
        runStarted = true;
      } else {
        ctx.lineTo(px, py - 1);
      }
    }
    ctx.stroke();
  }

  const landingX = plotLeft + Math.min(result.carryMeters, maxDisplayMeters) * scaleX;
  const totalX = plotLeft + Math.min(result.totalMeters, maxDisplayMeters) * scaleX;

  const markerColor = "#d11a2a";
  ctx.fillStyle = markerColor;
  ctx.beginPath();
  ctx.arc(peakPoint.x, peakPoint.y, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(landingX, plotBottom, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(totalX, plotBottom, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = markerColor;
  ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText("最大到達点", clamp(peakPoint.x - 28, plotLeft + 2, plotLeft + maxDisplayMeters * scaleX - 72), clamp(peakPoint.y - 10, 20, plotBottom - 20));

  ctx.restore();
}

function drawTrajectory(previous, current) {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!previous && !current) return;

  const margin = { left: 18, right: 18, top: 12, bottom: 36 };
  const plotLeft = margin.left;
  const plotRight = canvas.width - margin.right;
  const plotTop = margin.top;
  const plotBottom = canvas.height - margin.bottom;
  const width = plotRight - plotLeft;
  const height = plotBottom - plotTop;

  const maxHorizontalMeters = computeMaxDisplayMeters(previous?.totalMeters, current?.totalMeters);
  const maxDisplayYMeters = computeMaxDisplayYMeters(maxHorizontalMeters, width, height);

  // 1yd : 1yd を保つために、Y軸レンジからX軸レンジを逆算する。
  const aspectBasedHorizontalMeters = (maxDisplayYMeters * width) / Math.max(height, EPSILON);
  const maxDisplayMeters = Math.max(maxHorizontalMeters, aspectBasedHorizontalMeters);
  const scale = width / Math.max(maxDisplayMeters, EPSILON);
  const scaleX = scale;
  const scaleY = scale;

  ctx.save();
  ctx.fillStyle = "#f5f7fb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(50, 60, 80, 0.26)";
  ctx.lineWidth = 1;
  ctx.strokeRect(plotLeft, plotTop, width, height);
  ctx.restore();

  const majorYd = 50;
  const minorYd = 10;
  const maxDisplayYardsX = Math.floor(maxDisplayMeters / METERS_PER_YARD);
  const maxDisplayYardsY = Math.floor(maxDisplayYMeters / METERS_PER_YARD);

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
    ctx.fillText(`${yd}`, plotLeft - 14, y + 4);
  }
  ctx.fillText("飛距離 [yd]", plotRight - 62, canvas.height - 10);
  ctx.fillText("高さ [yd]", plotLeft + 4, plotTop + 14);
  ctx.restore();

  ctx.save();
  ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#12161f";
  const legendY = plotTop + 18;

  const drawLegend = (label, color, x) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, legendY - 4);
    ctx.lineTo(x + 24, legendY - 4);
    ctx.stroke();
    ctx.fillText(label, x + 30, legendY);
  };

  const legendBaseX = plotRight - 180;
  drawLegend("一つ前(ゴースト)", "rgba(20, 130, 245, 1)", legendBaseX);
  drawLegend("現在", "rgba(255, 118, 30, 1)", legendBaseX + 112);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(20, 25, 35, 0.50)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotBottom);
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();
  ctx.restore();

  drawSingleTrajectory(previous, "rgba(20, 130, 245, 1)", scaleX, scaleY, plotLeft, plotBottom, maxDisplayMeters);
  drawSingleTrajectory(current, "rgba(255, 118, 30, 1)", scaleX, scaleY, plotLeft, plotBottom, maxDisplayMeters);
}

function createSingleForm() {
  if (!hasDom) return;

  const form = document.getElementById("distance-form");
  if (!form) return;

  const refs = {
    error: document.getElementById("error-message"),
    headSpeedInput: document.getElementById("headSpeed"),
    smashFactorInput: document.getElementById("smashFactor"),
    launchAngleInput: document.getElementById("launchAngle"),
    spinRateInput: document.getElementById("spinRate"),
    windSpeedInput: document.getElementById("windSpeed"),
    headSpeedValue: document.getElementById("headSpeedValue"),
    smashFactorValue: document.getElementById("smashFactorValue"),
    launchAngleValue: document.getElementById("launchAngleValue"),
    spinRateValue: document.getElementById("spinRateValue"),
    windSpeedValue: document.getElementById("windSpeedValue"),
    ballSpeedPreview: document.getElementById("ballSpeedPreview"),
    maxHeightResultPrevious: document.getElementById("maxHeightResultPrevious"),
    maxHeightResultCurrent: document.getElementById("maxHeightResultCurrent"),
    carryResultPrevious: document.getElementById("carryResultPrevious"),
    carryResultCurrent: document.getElementById("carryResultCurrent"),
    totalResultPrevious: document.getElementById("totalResultPrevious"),
    totalResultCurrent: document.getElementById("totalResultCurrent"),
    resetButton: document.getElementById("reset-form"),
  };

  const inputs = [refs.headSpeedInput, refs.smashFactorInput, refs.launchAngleInput, refs.spinRateInput, refs.windSpeedInput];

  const updateOutputs = () => {
    const headSpeed = Number(refs.headSpeedInput.value);
    const smashFactor = Number(refs.smashFactorInput.value);
    refs.headSpeedValue.textContent = headSpeed.toFixed(1);
    refs.smashFactorValue.textContent = smashFactor.toFixed(2);
    refs.launchAngleValue.textContent = `${Number(refs.launchAngleInput.value).toFixed(1)}°`;
    refs.spinRateValue.textContent = Number(refs.spinRateInput.value).toFixed(0);

    const windRaw = Number(refs.windSpeedInput.value);
    refs.windSpeedValue.textContent = computeWindDisplayValue(windRaw).toFixed(1);
    updateWindSliderIndicator(refs.windSpeedInput);

    refs.ballSpeedPreview.textContent = `${(headSpeed * smashFactor).toFixed(1)} m/s`;
  };

  const showError = (message) => {
    refs.error.textContent = message;
    refs.error.classList.add("show");
  };

  const clearError = () => {
    refs.error.textContent = "";
    refs.error.classList.remove("show");
  };

  inputs.forEach((input) => input.addEventListener("input", updateOutputs));

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const error = validateInputs(
      refs.headSpeedInput.value.trim(),
      refs.smashFactorInput.value.trim(),
      refs.launchAngleInput.value.trim(),
      refs.spinRateInput.value.trim(),
      refs.windSpeedInput.value.trim()
    );

    if (error) {
      showError(error);
      refs.maxHeightResultCurrent.textContent = "現在: -";
      refs.carryResultCurrent.textContent = "現在: -";
      refs.totalResultCurrent.textContent = "現在: -";
      currentResult = null;
      drawTrajectory(previousResult, currentResult);
      return;
    }

    clearError();

    const result = calculateDistances(
      Number(refs.headSpeedInput.value),
      Number(refs.smashFactorInput.value),
      Number(refs.launchAngleInput.value),
      Number(refs.spinRateInput.value),
      toPhysicsWind(Number(refs.windSpeedInput.value))
    );

    previousResult = currentResult;
    currentResult = result;

    refs.maxHeightResultCurrent.textContent = `現在: ${result.maxHeightMeters.toFixed(1)} m`;
    refs.carryResultCurrent.textContent = `現在: ${(result.carryMeters / METERS_PER_YARD).toFixed(1)} yd`;
    refs.totalResultCurrent.textContent = `現在: ${(result.totalMeters / METERS_PER_YARD).toFixed(1)} yd`;

    if (previousResult) {
      refs.maxHeightResultPrevious.textContent = `一つ前: ${previousResult.maxHeightMeters.toFixed(1)} m`;
      refs.carryResultPrevious.textContent = `一つ前: ${(previousResult.carryMeters / METERS_PER_YARD).toFixed(1)} yd`;
      refs.totalResultPrevious.textContent = `一つ前: ${(previousResult.totalMeters / METERS_PER_YARD).toFixed(1)} yd`;
    } else {
      refs.maxHeightResultPrevious.textContent = "一つ前: -";
      refs.carryResultPrevious.textContent = "一つ前: -";
      refs.totalResultPrevious.textContent = "一つ前: -";
    }

    drawTrajectory(previousResult, currentResult);
  });

  if (refs.resetButton) {
    refs.resetButton.addEventListener("click", () => {
      form.reset();
      previousResult = null;
      currentResult = null;
      clearError();
      refs.maxHeightResultPrevious.textContent = "一つ前: -";
      refs.maxHeightResultCurrent.textContent = "現在: -";
      refs.carryResultPrevious.textContent = "一つ前: -";
      refs.carryResultCurrent.textContent = "現在: -";
      refs.totalResultPrevious.textContent = "一つ前: -";
      refs.totalResultCurrent.textContent = "現在: -";
      updateOutputs();
      drawTrajectory(previousResult, currentResult);
    });
  }

  updateOutputs();
}

if (hasDom) {
  createSingleForm();
  drawTrajectory(previousResult, currentResult);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeWindDisplayValue,
    toPhysicsWind,
    computeMaxDisplayMeters,
    computeMaxDisplayYMeters,
    calculateDistances,
    validateInputs,
    computeRunMetersFromLanding,
    computeRunWithBounceFromLanding,
  };
}
