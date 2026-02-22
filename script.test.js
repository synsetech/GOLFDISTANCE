const assert = require('assert');
const {
  computeWindDisplayValue,
  toPhysicsWind,
  computeMaxDisplayMeters,
  calculateDistances,
  validateInputs,
} = require('./script.js');

function approxGreater(a, b, msg) {
  assert.ok(a > b, `${msg} expected ${a} > ${b}`);
}

// wind sign conversion
assert.strictEqual(computeWindDisplayValue(3), -3);
assert.strictEqual(computeWindDisplayValue(-4.5), 4.5);
assert.strictEqual(toPhysicsWind(3), -3);
assert.strictEqual(toPhysicsWind(-4.5), 4.5);

// dynamic x-axis: minimum floor and +50yd padded rounding
const minDisplay = computeMaxDisplayMeters(0, 0);
assert.ok(minDisplay >= 150 * 0.9144);

const meters300yd = 300 * 0.9144;
const meters330yd = 330 * 0.9144;
const display = computeMaxDisplayMeters(meters300yd, meters330yd);
const yards = display / 0.9144;
assert.strictEqual(yards % 50, 0);
assert.ok(yards >= 380); // 330 + 50

// validation checks
assert.strictEqual(validateInputs('45', '1.45', '14', '2500', '0'), null);
assert.ok(validateInputs('', '1.45', '14', '2500', '0'));
assert.ok(validateInputs('20', '1.45', '14', '2500', '0'));

// physics sanity: strong headwind should reduce carry vs strong tailwind under current convention
const base = { headSpeed: 45, smashFactor: 1.45, launch: 14, spin: 2500 };
const tailwindResult = calculateDistances(base.headSpeed, base.smashFactor, base.launch, base.spin, toPhysicsWind(8));
const headwindResult = calculateDistances(base.headSpeed, base.smashFactor, base.launch, base.spin, toPhysicsWind(-8));
approxGreater(tailwindResult.carryMeters, headwindResult.carryMeters, 'tailwind carry should be greater than headwind carry');
assert.ok(tailwindResult.totalMeters >= tailwindResult.carryMeters);
assert.ok(headwindResult.totalMeters >= headwindResult.carryMeters);

console.log('All tests passed');
