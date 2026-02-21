const OPTIMAL_SPIN_RPM = 2400; // ドライバーの理想帯(2200〜2600rpm)の代表値
const CARRY_COEFFICIENT = 0.0205;
const GRAVITY = 9.81;
const RUN_RATIO = 0.13; // 乾いたフェアウェイでキャリーの10〜15%程度転がる想定の中間値

const form = document.getElementById("distance-form");
const errorMessage = document.getElementById("error-message");
const carryResult = document.getElementById("carryResult");
const totalResult = document.getElementById("totalResult");
const canvas = document.getElementById("trajectoryCanvas");
const ctx = canvas.getContext("2d");

const headSpeedInput = document.getElementById("headSpeed");
const smashFactorInput = document.getElementById("smashFactor");
const launchAngleInput = document.getElementById("launchAngle");
const headSpeedValue = document.getElementById("headSpeedValue");
const smashFactorValue = document.getElementById("smashFactorValue");
const launchAngleValue = document.getElementById("launchAngleValue");

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add("show");
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.classList.remove("show");
}

function updateOutputs() {
  headSpeedValue.textContent = Number(headSpeedInput.value).toFixed(1);
  smashFactorValue.textContent = Number(smashFactorInput.value).toFixed(2);
  launchAngleValue.textContent = `${Number(launchAngleInput.value).toFixed(1)}°`;
}

function calculateCarryDistance(headSpeed, smashFactor, launchAngleDeg) {
  const ballSpeed = headSpeed * smashFactor;
  // 可変角度・固定スピンを前提とした簡易キャリー式（校正係数で現実値へ寄せる）
  const carryMeters =
    (Math.pow(ballSpeed, 2) * Math.sin((2 * launchAngleDeg * Math.PI) / 180)) /
    GRAVITY *
    CARRY_COEFFICIENT *
    (1 - (OPTIMAL_SPIN_RPM - 2400) / 10000);

  return {
    ballSpeed,
    carryMeters: Math.max(carryMeters, 0),
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

  if (launchAngle < 10 || launchAngle > 20) {
    return "打ち出し角度は 10.0〜20.0 度の範囲で入力してください。";
  }

  return null;
}

function drawTrajectory(carryMeters, launchAngleDeg) {
  const maxHeight = Math.tan((launchAngleDeg * Math.PI) / 180) * (carryMeters / 4);
  const pad = 36;
  const groundY = canvas.height - pad;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#4f6580";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, groundY);
  ctx.lineTo(canvas.width - pad, groundY);
  ctx.stroke();

  const width = canvas.width - pad * 2;
  const height = canvas.height - pad * 2;
  const peakX = carryMeters / 2;
  const scaleX = width / Math.max(carryMeters, 1);
  const scaleY = height / Math.max(maxHeight * 1.4, 1);

  ctx.strokeStyle = "#1266f1";
  ctx.lineWidth = 3;
  ctx.beginPath();

  let peakPoint = { x: pad, y: groundY };

  for (let x = 0; x <= carryMeters; x += carryMeters / 80 || 1) {
    const y = (-4 * maxHeight * Math.pow(x - peakX, 2)) / Math.pow(carryMeters, 2) + maxHeight;
    const px = pad + x * scaleX;
    const py = groundY - y * scaleY;

    if (x === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }

    if (py < peakPoint.y) {
      peakPoint = { x: px, y: py };
    }
  }

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
    carryResult.textContent = "-";
    totalResult.textContent = "-";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  clearError();

  const headSpeed = Number(headSpeedRaw);
  const smashFactor = Number(smashFactorRaw);
  const launchAngle = Number(launchAngleRaw);
  const { carryMeters } = calculateCarryDistance(headSpeed, smashFactor, launchAngle);
  const runMeters = carryMeters * RUN_RATIO;
  const totalMeters = carryMeters + runMeters;

  carryResult.textContent = `${carryMeters.toFixed(1)} m`;
  totalResult.textContent = `${totalMeters.toFixed(1)} m`;

  drawTrajectory(carryMeters, launchAngle);
});

updateOutputs();
