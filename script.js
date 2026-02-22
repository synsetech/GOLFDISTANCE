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

const SPIN_DECAY_RATE = 0.04;
const CD_SPIN_LINEAR = 0.35;
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

function computeMaxDisplayMeters(totalA, totalB) {
  const maxTotalMeters = Math.max(totalA || 0, totalB || 0);
  const paddedYards = maxTotalMeters / METERS_PER_YARD + 50;
  const roundedYards = Math.ceil(paddedYards / X_TICK_YARDS) * X_TICK_YARDS;
  return Math.max(roundedYards * METERS_PER_YARD, 150 * METERS_PER_YARD);
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
  if (re <= 75000) return cdLow;
  if (re >= 100000) return cdHigh;
  return lerp(cdLow, cdHigh, (re - 75000) / 25000);
}

function clFromSpinFactor(s) {
  return Math.max(0, -3.25 * s * s + 1.99 * s);
}

function spinFactorFrom(speed, spinRpm) {
  const omega = (spinRpm * 2 * Math.PI) / 60;
  return (omega * BALL_RADIUS) / Math.max(speed, EPSILON);
}

function effectiveSpinRate(spinRate) {
  if (spinRate <= 3000) return spinRate;
  return lerp(3000, 3800, (spinRate - 3000) / 2000);
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
  let state = { x: 0, y: 0, vx: ballSpeed * Math.cos(launchRad), vy: ballSpeed * Math.sin(launchRad) };

  let maxHeight = 0;
  const trajectory = [{ x: 0, y: 0 }];
  let landingState = state;
  let tSec = 0;

  for (let i = 0; i < 3000; i += 1) {
    const previous = { ...state };

    const relVx = state.vx + windSpeed;
    const relVy = state.vy;
    const airSpeed = Math.max(Math.hypot(relVx, relVy), EPSILON);

    const re = clamp((airSpeed * BALL_DIAMETER) / AIR_KINEMATIC_VISCOSITY, 50000, 200000);

    const spin0 = effectiveSpinRate(spinRate);
    const spinNow = spinAtTimeRpm(spin0, tSec);
    const S = spinFactorFrom(airSpeed, spinNow);

    const cl = clFromSpinFactor(S);
    const cd = clamp(cdFromRe(re) + CD_SPIN_LINEAR * S, 0.05, 1.2);

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
  const spinLand = spinAtTimeRpm(effectiveSpinRate(spinRate), flight.flightTimeSec);
  const runMeters = computeRunMetersFromLanding(flight.landingVx, flight.landingVy, spinLand);

  return {
    ballSpeed,
    carryMeters: flight.carryMeters,
    totalMeters: flight.carryMeters + runMeters,
    trajectory: flight.trajectory,
    maxHeightMeters: flight.maxHeightMeters,
  };
}

function validateInputs(headSpeedRaw, smashFactorRaw, launchAngleRaw, spinRateRaw, windSpeedRaw) {
  if (!headSpeedRaw || !smashFactorRaw || !launchAngleRaw || !spinRateRaw || !windSpeedRaw) return "すべての入力欄を入力してください。";

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);
  const spinRate = Number(spinRateRaw);
  const windSpeed = Number(windSpeedRaw);

  if (![headSpeed, smashFactor, launchAngle, spinRate, windSpeed].every(Number.isFinite)) return "数値形式で入力してください。";
  if (headSpeed < 25 || headSpeed > 60) return "ヘッドスピードは 25.0〜60.0 の範囲で入力してください。";
  if (smashFactor < 1.3 || smashFactor > 1.56) return "ミート率は 1.30〜1.56 の範囲で入力してください。";
  if (launchAngle < 10 || launchAngle > 18) return "打ち出し角は 10.0〜18.0 度の範囲で入力してください。";
  if (spinRate < 1500 || spinRate > 5000) return "スピンレートは 1500〜5000 rpm の範囲で入力してください。";
  if (windSpeed < -10 || windSpeed > 10) return "風向風速は -10.0〜10.0 m/s の範囲で入力してください。";

  return null;
}

const hasDom = typeof document !== "undefined";

if (hasDom) {
  const form = document.getElementById("distance-form");
  const errorMessage = document.getElementById("error-message");
  const canvas = document.getElementById("trajectoryCanvas");
  const ctx = canvas.getContext("2d");

  const enableB = document.getElementById("enableB");
  const groupB = document.getElementById("groupB");
  const resultB = document.getElementById("resultB");
  const resultDiff = document.getElementById("resultDiff");

  const ids = {
    A: ["headSpeed", "smashFactor", "launchAngle", "spinRate", "windSpeed"],
    B: ["headSpeed", "smashFactor", "launchAngle", "spinRate", "windSpeed"],
  };

  function getInput(key, side) { return document.getElementById(`${key}${side}`); }
  function getValueEl(key, side) { return document.getElementById(`${key}${side}Value`); }

  function updateWindSliderIndicator(slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const val = Number(slider.value);
    const centerPct = ((0 - min) / (max - min)) * 100;
    const valPct = ((val - min) / (max - min)) * 100;

    if (Math.abs(val) < 1e-9) {
      slider.style.background = "linear-gradient(to right, #cfd8e3 0%, #cfd8e3 100%)";
      return;
    }
    const left = Math.min(centerPct, valPct);
    const right = Math.max(centerPct, valPct);
    slider.style.background = `linear-gradient(to right, #cfd8e3 0%, #cfd8e3 ${left}%, ${val > 0 ? "#ff6f61" : "#4f9dff"} ${left}%, ${val > 0 ? "#ff6f61" : "#4f9dff"} ${right}%, #cfd8e3 ${right}%, #cfd8e3 100%)`;
  }

  function updateSidePreview(side) {
    const hs = Number(getInput("headSpeed", side).value);
    const sf = Number(getInput("smashFactor", side).value);
    getValueEl("headSpeed", side).textContent = hs.toFixed(1);
    getValueEl("smashFactor", side).textContent = sf.toFixed(2);
    getValueEl("launchAngle", side).textContent = `${Number(getInput("launchAngle", side).value).toFixed(1)}°`;
    getValueEl("spinRate", side).textContent = Number(getInput("spinRate", side).value).toFixed(0);

    const windRaw = Number(getInput("windSpeed", side).value);
    getValueEl("windSpeed", side).textContent = computeWindDisplayValue(windRaw).toFixed(1);
    updateWindSliderIndicator(getInput("windSpeed", side));

    document.getElementById(`ballSpeed${side}Preview`).textContent = `${(hs * sf).toFixed(1)} m/s`;
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add("show");
  }

  function clearError() {
    errorMessage.textContent = "";
    errorMessage.classList.remove("show");
  }

  function drawTrajectory(resultA, resultB) {
    const pad = 36;
    const groundY = canvas.height - pad;
    const width = canvas.width - pad * 2;
    const height = canvas.height - pad * 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const maxDisplayMeters = computeMaxDisplayMeters(resultA?.totalMeters || 0, resultB?.totalMeters || 0);
    const maxHeight = Math.max(resultA?.maxHeightMeters || 0, resultB?.maxHeightMeters || 0);
    const scaleX = width / maxDisplayMeters;
    const scaleY = height / Math.max(maxHeight * 1.35, 1);

    ctx.strokeStyle = "#d0e2ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, groundY);
    ctx.lineTo(canvas.width - pad, groundY);
    ctx.stroke();

    const maxDisplayYards = Math.floor(maxDisplayMeters / METERS_PER_YARD);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.fillStyle = "rgba(230,240,255,0.8)";
    ctx.font = "11px sans-serif";
    for (let yard = X_TICK_YARDS; yard <= maxDisplayYards; yard += X_TICK_YARDS) {
      const x = pad + yard * METERS_PER_YARD * scaleX;
      ctx.beginPath();
      ctx.moveTo(x, groundY);
      ctx.lineTo(x, groundY - 8);
      ctx.stroke();
      ctx.fillText(`${yard}`, x - 10, groundY + 16);
    }

    function drawOne(result, lineColor, runColor) {
      if (!result) return;
      let peak = { x: 0, y: Infinity };

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      result.trajectory.forEach((p, idx) => {
        const px = pad + p.x * scaleX;
        const py = groundY - p.y * scaleY;
        if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        if (py < peak.y) peak = { x: px, y: py };
      });
      ctx.stroke();

      const carryX = pad + result.carryMeters * scaleX;
      const totalX = pad + result.totalMeters * scaleX;

      ctx.strokeStyle = runColor;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(carryX, groundY - 1);
      ctx.lineTo(totalX, groundY - 1);
      ctx.stroke();

      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(carryX, groundY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(totalX, groundY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ff3b30";
      ctx.beginPath();
      ctx.arc(peak.x, peak.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawOne(resultA, "#e33b3b", "#e33b3b");
    drawOne(resultB, "#2f7de1", "#2f7de1");
  }

  function calcForSide(side) {
    const raw = {
      headSpeed: getInput("headSpeed", side).value.trim(),
      smashFactor: getInput("smashFactor", side).value.trim(),
      launchAngle: getInput("launchAngle", side).value.trim(),
      spinRate: getInput("spinRate", side).value.trim(),
      windSpeed: getInput("windSpeed", side).value.trim(),
    };

    const error = validateInputs(raw.headSpeed, raw.smashFactor, raw.launchAngle, raw.spinRate, raw.windSpeed);
    if (error) return { error };

    const result = calculateDistances(
      Number(raw.headSpeed),
      Number(raw.smashFactor),
      Number(raw.launchAngle),
      Number(raw.spinRate),
      toPhysicsWind(Number(raw.windSpeed))
    );
    return { result };
  }

  function updateResults(resultA, resultB) {
    const yd = (m) => `${(m / METERS_PER_YARD).toFixed(1)} yd`;

    document.getElementById("maxHeightAResult").textContent = `${resultA.maxHeightMeters.toFixed(1)} m`;
    document.getElementById("carryAResult").textContent = yd(resultA.carryMeters);
    document.getElementById("totalAResult").textContent = yd(resultA.totalMeters);

    if (resultB) {
      document.getElementById("maxHeightBResult").textContent = `${resultB.maxHeightMeters.toFixed(1)} m`;
      document.getElementById("carryBResult").textContent = yd(resultB.carryMeters);
      document.getElementById("totalBResult").textContent = yd(resultB.totalMeters);

      document.getElementById("carryDiffResult").textContent = yd(resultB.carryMeters - resultA.carryMeters);
      document.getElementById("totalDiffResult").textContent = yd(resultB.totalMeters - resultA.totalMeters);
    } else {
      ["maxHeightBResult", "carryBResult", "totalBResult", "carryDiffResult", "totalDiffResult"].forEach((id) => {
        document.getElementById(id).textContent = "-";
      });
    }
  }

  function toggleBState() {
    const enabled = enableB.checked;
    groupB.classList.toggle("disabled", !enabled);
    resultB.style.display = enabled ? "grid" : "none";
    resultDiff.style.display = enabled ? "grid" : "none";
  }

  ["A", "B"].forEach((side) => {
    ids[side].forEach((key) => {
      getInput(key, side).addEventListener("input", () => updateSidePreview(side));
    });
    updateSidePreview(side);
  });

  enableB.addEventListener("change", toggleBState);
  toggleBState();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearError();

    const calcA = calcForSide("A");
    if (calcA.error) {
      showError(`入力A: ${calcA.error}`);
      return;
    }

    let resultBData = null;
    if (enableB.checked) {
      const calcB = calcForSide("B");
      if (calcB.error) {
        showError(`入力B: ${calcB.error}`);
        return;
      }
      resultBData = calcB.result;
    }

    updateResults(calcA.result, resultBData);
    drawTrajectory(calcA.result, resultBData);
  });
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
