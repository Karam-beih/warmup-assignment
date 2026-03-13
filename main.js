'use strict';
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a 12-hour time string ("h:mm:ss am" / "h:mm:ss pm") to total seconds
 * since midnight.
 *
 * Special cases:
 *   12:xx:xx am  →  0 h  (midnight)
 *   12:xx:xx pm  → 12 h  (noon)
 */
function convert12HourToSeconds(timeStr) {
    timeStr = timeStr.trim();
    const spaceIdx = timeStr.lastIndexOf(' ');
    const timePart = timeStr.substring(0, spaceIdx).trim();
    const period   = timeStr.substring(spaceIdx + 1).trim().toLowerCase();

    const parts   = timePart.split(':');
    let   hours   = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(parts[2], 10);

    if (period === 'am') {
        if (hours === 12) hours = 0;
    } else {
        if (hours !== 12) hours += 12;
    }

    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Convert a duration string "h:mm:ss" (hours may be multi-digit) to total
 * seconds.
 */
function durationToSeconds(dur) {
    dur = dur.trim();
    const parts = dur.split(':');
    return parseInt(parts[0], 10) * 3600 +
           parseInt(parts[1], 10) * 60  +
           parseInt(parts[2], 10);
}

/**
 * Convert total seconds to a duration string "h:mm:ss".
 * Hours are NOT zero-padded; minutes and seconds are always two digits.
 */
function secondsToDuration(totalSec) {
    totalSec = Math.round(Math.abs(totalSec));
    const h  = Math.floor(totalSec / 3600);
    const m  = Math.floor((totalSec % 3600) / 60);
    const s  = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Return the English weekday name for a "yyyy-mm-dd" date string.
 */
function getDayOfWeek(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const date = new Date(y, mo - 1, d);
    return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
}

/**
 * Return true if a "yyyy-mm-dd" date falls within the Eid al-Fitr period
 * (April 10-30, 2025, inclusive).
 */
function isEidPeriod(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    return y === 2025 && mo === 4 && d >= 10 && d <= 30;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 1 — getShiftDuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the duration between startTime and endTime.
 *
 * @param {string} startTime  e.g. "6:01:20 am"
 * @param {string} endTime    e.g. "4:13:40 pm"
 * @returns {string}          e.g. "10:12:20"
 */
function getShiftDuration(startTime, endTime) {
    const startSec = convert12HourToSeconds(startTime);
    const endSec   = convert12HourToSeconds(endTime);
    return secondsToDuration(endSec - startSec);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 2 — getIdleTime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate idle (non-delivery) time in a shift.
 * Delivery window = 08:00:00 to 22:00:00 (8 AM to 10 PM) inclusive.
 * Any time before 8 AM or after 10 PM is idle.
 *
 * @param {string} startTime  e.g. "6:00:00 am"
 * @param {string} endTime    e.g. "11:00:00 pm"
 * @returns {string}          idle time as "h:mm:ss"
 */
function getIdleTime(startTime, endTime) {
    const startSec       = convert12HourToSeconds(startTime);
    const endSec         = convert12HourToSeconds(endTime);
    const DELIVERY_START = 8  * 3600;  // 08:00:00
    const DELIVERY_END   = 22 * 3600;  // 22:00:00

    let idleSec = 0;

    // Idle before delivery window starts
    if (startSec < DELIVERY_START) {
        idleSec += Math.min(endSec, DELIVERY_START) - startSec;
    }

    // Idle after delivery window ends
    if (endSec > DELIVERY_END) {
        idleSec += endSec - Math.max(startSec, DELIVERY_END);
    }

    return secondsToDuration(idleSec);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 3 — getActiveTime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate active delivery time: shiftDuration - idleTime.
 *
 * @param {string} shiftDuration  e.g. "6:40:20"
 * @param {string} idleTime       e.g. "3:10:10"
 * @returns {string}              e.g. "3:30:10"
 */
function getActiveTime(shiftDuration, idleTime) {
    return secondsToDuration(durationToSeconds(shiftDuration) - durationToSeconds(idleTime));
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 4 — metQuota
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return whether a driver met the daily active-hour quota.
 * Normal quota  = 8 h 24 m (30240 s).
 * Eid quota     = 6 h (21600 s) for April 10-30, 2025.
 *
 * @param {string} date        "yyyy-mm-dd"
 * @param {string} activeTime  "h:mm:ss"
 * @returns {boolean}
 */
function metQuota(date, activeTime) {
    const quotaSec = isEidPeriod(date)
        ? 6 * 3600
        : 8 * 3600 + 24 * 60;
    return durationToSeconds(activeTime) >= quotaSec;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 5 — addShiftRecord
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a new shift record to the text file.
 *
 * Rules:
 *  - If a record for the same driverID + date already exists => return {}.
 *  - Otherwise compute all derived fields, insert the new line after the last
 *    existing record for that driverID (or at the end if driver not found),
 *    write the file, and return the full object.
 *
 * @param {string} textFile  path to shifts.txt
 * @param {object} shiftObj  { driverID, driverName, date, startTime, endTime }
 * @returns {object}         10-property shift object, or {}
 */
function addShiftRecord(textFile, shiftObj) {
    const { driverID, driverName, date, startTime, endTime } = shiftObj;

    const raw   = fs.readFileSync(textFile, 'utf8');
    const lines = raw.split('\n');

    // ── Duplicate check ──────────────────────────────────────────────────────
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const cols = trimmed.split(',');
        if (cols.length >= 3 &&
            cols[0].trim() === driverID.trim() &&
            cols[2].trim() === date.trim()) {
            return {};
        }
    }

    // ── Derive fields ────────────────────────────────────────────────────────
    const shiftDuration = getShiftDuration(startTime, endTime);
    const idleTime      = getIdleTime(startTime, endTime);
    const activeTime    = getActiveTime(shiftDuration, idleTime);
    const quota         = metQuota(date, activeTime);
    const hasBonus      = false;

    const newLine = [
        driverID.trim(),
        driverName.trim(),
        date.trim(),
        startTime.trim(),
        endTime.trim(),
        shiftDuration,
        idleTime,
        activeTime,
        String(quota),
        String(hasBonus)
    ].join(',');

    // ── Find insertion position ──────────────────────────────────────────────
    // Insert after the last line that belongs to this driverID.
    // If no such line exists, insert after the last non-empty line.
    let lastDriverIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '') continue;
        const cols = trimmed.split(',');
        if (cols[0].trim() === driverID.trim()) {
            lastDriverIdx = i;
        }
    }

    if (lastDriverIdx !== -1) {
        lines.splice(lastDriverIdx + 1, 0, newLine);
    } else {
        // Append: find last non-empty line index
        let lastNonEmpty = lines.length - 1;
        while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') {
            lastNonEmpty--;
        }
        lines.splice(lastNonEmpty + 1, 0, newLine);
    }

    // ── Write file ───────────────────────────────────────────────────────────
    let content = lines.join('\n').replace(/\n+$/, '') + '\n';
    fs.writeFileSync(textFile, content, 'utf8');

    return {
        driverID:      driverID.trim(),
        driverName:    driverName.trim(),
        date:          date.trim(),
        startTime:     startTime.trim(),
        endTime:       endTime.trim(),
        shiftDuration,
        idleTime,
        activeTime,
        metQuota:      quota,
        hasBonus
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 6 — setBonus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the hasBonus field for a specific driverID + date and write to file.
 * Returns nothing.
 *
 * @param {string}  textFile  path to shifts.txt
 * @param {string}  driverID
 * @param {string}  date      "yyyy-mm-dd"
 * @param {boolean} newValue
 */
function setBonus(textFile, driverID, date, newValue) {
    const raw   = fs.readFileSync(textFile, 'utf8');
    const lines = raw.split('\n');

    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '') continue;
        const cols = trimmed.split(',');
        if (cols[0].trim() === driverID.trim() && cols[2].trim() === date.trim()) {
            cols[9] = String(newValue);
            lines[i] = cols.join(',');
            updated = true;
            break;
        }
    }

    if (updated) {
        const content = lines.join('\n').replace(/\n+$/, '') + '\n';
        fs.writeFileSync(textFile, content, 'utf8');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 7 — countBonusPerMonth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count records where driverID and month match and hasBonus is true.
 * Returns -1 if driverID does not exist in the file.
 *
 * @param {string} textFile  path to shifts.txt
 * @param {string} driverID
 * @param {string} month     "4" or "04"
 * @returns {number}
 */
function countBonusPerMonth(textFile, driverID, month) {
    const targetMonth = parseInt(month, 10);
    const raw         = fs.readFileSync(textFile, 'utf8');
    const lines       = raw.split('\n').filter(l => l.trim() !== '');

    let driverExists = false;
    let count        = 0;

    for (const line of lines) {
        const cols = line.split(',');
        if (cols[0].trim() !== driverID.trim()) continue;
        driverExists = true;

        const recordMonth = parseInt(cols[2].trim().split('-')[1], 10);
        if (recordMonth === targetMonth && cols[9].trim() === 'true') {
            count++;
        }
    }

    return driverExists ? count : -1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 8 — getTotalActiveHoursPerMonth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sum all activeTime values for a driver in a given month (including day-off
 * days).
 *
 * @param {string} textFile  path to shifts.txt
 * @param {string} driverID
 * @param {number} month
 * @returns {string}         "hhh:mm:ss"
 */
function getTotalActiveHoursPerMonth(textFile, driverID, month) {
    const targetMonth = parseInt(month, 10);
    const raw         = fs.readFileSync(textFile, 'utf8');
    const lines       = raw.split('\n').filter(l => l.trim() !== '');

    let totalSec = 0;

    for (const line of lines) {
        const cols = line.split(',');
        if (cols[0].trim() !== driverID.trim()) continue;

        const recordMonth = parseInt(cols[2].trim().split('-')[1], 10);
        if (recordMonth !== targetMonth) continue;

        totalSec += durationToSeconds(cols[7].trim());
    }

    return secondsToDuration(totalSec);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 9 — getRequiredHoursPerMonth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate total required hours for a driver in a month.
 *
 * Rules:
 *  - Only count days on which the driver has a recorded shift.
 *  - Skip days that fall on the driver's weekly dayOff.
 *  - Normal daily quota = 8 h 24 m; Eid period (Apr 10-30, 2025) = 6 h.
 *  - Subtract 2 h for each bonus earned that month.
 *  - Result floored to 0 if bonuses reduce it below zero.
 *
 * @param {string} textFile    path to shifts.txt
 * @param {string} rateFile    path to driverRates.txt
 * @param {number} bonusCount
 * @param {string} driverID
 * @param {number} month
 * @returns {string}           "hhh:mm:ss"
 */
function getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month) {
    // Read driver's day off
    const rateRaw   = fs.readFileSync(rateFile, 'utf8');
    const rateLines = rateRaw.split('\n').filter(l => l.trim() !== '');

    let dayOff = null;
    for (const line of rateLines) {
        const cols = line.split(',');
        if (cols[0].trim() === driverID.trim()) {
            dayOff = cols[1].trim();
            break;
        }
    }

    // Sum quota for each qualifying shift record
    const targetMonth  = parseInt(month, 10);
    const shiftRaw     = fs.readFileSync(textFile, 'utf8');
    const shiftLines   = shiftRaw.split('\n').filter(l => l.trim() !== '');

    let totalRequiredSec = 0;

    for (const line of shiftLines) {
        const cols = line.split(',');
        if (cols[0].trim() !== driverID.trim()) continue;

        const dateStr     = cols[2].trim();
        const recordMonth = parseInt(dateStr.split('-')[1], 10);
        if (recordMonth !== targetMonth) continue;

        // Skip day-off days
        if (dayOff && getDayOfWeek(dateStr) === dayOff) continue;

        // Quota for this specific day
        const quotaSec = isEidPeriod(dateStr)
            ? 6 * 3600
            : 8 * 3600 + 24 * 60;

        totalRequiredSec += quotaSec;
    }

    // Deduct 2 h per bonus
    totalRequiredSec -= bonusCount * 2 * 3600;
    if (totalRequiredSec < 0) totalRequiredSec = 0;

    return secondsToDuration(totalRequiredSec);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FUNCTION 10 — getNetPay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate a driver's net monthly pay after hour-based deductions.
 *
 * Tier allowances (missing hours with no penalty):
 *   1 => 50 h  |  2 => 20 h  |  3 => 10 h  |  4 => 3 h
 *
 * Formula:
 *   missingHours           = floor((requiredSec - actualSec) / 3600)
 *   billableHours          = max(0, missingHours - allowance)
 *   deductionRatePerHour   = floor(basePay / 185)
 *   salaryDeduction        = billableHours x deductionRatePerHour
 *   netPay                 = basePay - salaryDeduction
 *
 * @param {string} driverID
 * @param {string} actualHours    "hhh:mm:ss"
 * @param {string} requiredHours  "hhh:mm:ss"
 * @param {string} rateFile       path to driverRates.txt
 * @returns {number}              net pay as integer
 */
function getNetPay(driverID, actualHours, requiredHours, rateFile) {
    const TIER_ALLOWANCE = { 1: 50, 2: 20, 3: 10, 4: 3 };

    const raw   = fs.readFileSync(rateFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');

    let basePay = 0;
    let tier    = 1;

    for (const line of lines) {
        const cols = line.split(',');
        if (cols[0].trim() === driverID.trim()) {
            basePay = parseInt(cols[2].trim(), 10);
            tier    = parseInt(cols[3].trim(), 10);
            break;
        }
    }

    const actualSec   = durationToSeconds(actualHours);
    const requiredSec = durationToSeconds(requiredHours);

    // No deduction when driver met or exceeded required hours
    if (actualSec >= requiredSec) {
        return basePay;
    }

    // Full missing hours only (ignore remaining minutes)
    const missingHours  = Math.floor((requiredSec - actualSec) / 3600);
    const allowance     = TIER_ALLOWANCE[tier] !== undefined ? TIER_ALLOWANCE[tier] : 0;
    const billableHours = Math.max(0, missingHours - allowance);

    if (billableHours === 0) return basePay;

    const deductionRate = Math.floor(basePay / 185);
    const deduction     = billableHours * deductionRate;

    return basePay - deduction;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    getShiftDuration,
    getIdleTime,
    getActiveTime,
    metQuota,
    addShiftRecord,
    setBonus,
    countBonusPerMonth,
    getTotalActiveHoursPerMonth,
    getRequiredHoursPerMonth,
    getNetPay
};
