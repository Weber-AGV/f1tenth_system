"use strict";

/* ==========================================================
   LIDAR STEER-AWAY (autonomous run)

   While an autonomous run drives at a set speed and steering, this
   looks at the front of the latest LiDAR scan and, when something is
   in the way, replaces the run's steering with a turn away from it.
   Nothing else changes: speed is untouched, and the robot's own
   obstacle stop (system_diagnostics.py) is still the last line of
   defence if the turn is not enough.

   Pure function: scan in, steering out, no DOM. See
   tests/verify_avoid.mjs.

   Angles follow REP-103: 0 is straight ahead, positive is LEFT, and a
   positive steering angle turns left. So steering away from an
   obstacle on the left is a NEGATIVE angle.
========================================================== */

const AVOID = {
  frontHalfAngle: 20 * Math.PI / 180,   // "in front" = this far either side of dead ahead
  sideNear: 8 * Math.PI / 180,          // side sectors run from here...
  sideFar: 75 * Math.PI / 180,          // ...out to here, to pick the roomier side
  lookaheadBase: 0.8,                   // m of warning at a standstill
  lookaheadPerMs: 0.8,                  // plus this many m per m/s of speed
  hardStop: 0.4,                        // m: at or inside this, full lock
  releaseFactor: 1.25,                  // the turn lets go once clear by this much extra
  minTurn: 0.5                          // never less than this fraction of full lock once avoiding
};

/* How far ahead to care about, for this speed. */
function avoidLookahead(speed) {
  return AVOID.lookaheadBase + AVOID.lookaheadPerMs * Math.max(0, speed);
}

/* state: { dir } kept between calls by the caller, so the car commits
   to one side instead of flipping left and right at a symmetric
   obstacle. Returns { steer, active, front, dir }; steer is null when
   not avoiding, meaning "leave the steering alone".

   scan is a sensor_msgs/LaserScan as rosbridge sends it; speed in
   m/s; maxSteer the steering limit in radians. */
function lidarAvoid(scan, speed, maxSteer, state) {

  const idle = { steer: null, active: false, front: null, dir: 0 };

  /* reversing: the sensor looks forward, so it has nothing to say */
  if (!scan || !(speed > 0) || !(maxSteer > 0)) {
    if (state) state.dir = 0;
    return idle;
  }

  const ranges = scan.ranges || [];
  const angleMin = Number(scan.angle_min);
  const angleInc = Number(scan.angle_increment);
  const rangeMin = Number(scan.range_min);
  const rangeMax = Number(scan.range_max);

  if (!ranges.length || !Number.isFinite(angleMin) || !(angleInc > 0)) return idle;

  const min = (from, to) => {
    const hit = sectorMin(ranges, angleMin, angleInc, rangeMin, rangeMax, from, to);
    return hit ? hit.range : Infinity;
  };

  const front = min(-AVOID.frontHalfAngle, AVOID.frontHalfAngle);
  const trigger = avoidLookahead(speed);
  const release = trigger * AVOID.releaseFactor;

  /* committed to a side: stay on it until the way ahead is clear */
  const committed = state && state.dir !== 0;

  if (front > (committed ? release : trigger)) {
    if (state) state.dir = 0;
    return { steer: null, active: false, front: Number.isFinite(front) ? front : null, dir: 0 };
  }

  let dir = committed ? state.dir : 0;

  if (!dir) {
    /* more room on the left -> turn left (+), else right (-). A tie
       goes right, arbitrarily but consistently. */
    const left = min(AVOID.sideNear, AVOID.sideFar);
    const right = min(-AVOID.sideFar, -AVOID.sideNear);
    dir = left > right ? 1 : -1;
    if (state) state.dir = dir;
  }

  /* closer = harder: from minTurn of full lock at the trigger distance
     up to full lock at hardStop */
  const span = Math.max(0.01, trigger - AVOID.hardStop);
  const urgency = Math.max(0, Math.min(1, (trigger - front) / span));
  const strength = AVOID.minTurn + (1 - AVOID.minTurn) * urgency;

  return { steer: dir * maxSteer * strength, active: true, front, dir };
}
