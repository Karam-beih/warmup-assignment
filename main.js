'use strict';
const fs = require('fs');

function convert12HourToSeconds(timeStr) {
    timeStr = timeStr.trim();
    const spaceIdx = timeStr.lastIndexOf(' ');
    const timePart = timeStr.substring(0, spaceIdx).trim();
    const period = timeStr.substring(spaceIdx + 1).trim().toLowerCase();

    const parts = timePart.split(':');
    let hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(parts[2], 10);

    if (period === 'am') {
        if (hours === 12) hours = 0;
    } else {
        if (hours !== 12) hours += 12;
    }

    return hours * 3600 + minutes * 60 + seconds;
}

function durationToSeconds(dur) {
    dur = dur.trim();
    const parts = dur.split(':');
    return parseInt(parts[0], 10) * 3600 +
           parseInt(parts[1], 10) * 60 +
           parseInt(parts[2], 10);
}

function secondsToDuration(totalSec) {
    totalSec = Math.round(Math.abs(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getDayOfWeek(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const date = new Date(y, mo - 1, d);
    return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
}

function isEidPeriod(dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    return y === 2025 && mo === 4 && d >= 10 && d <= 30;
}

function getShiftDuration(startTime, endTime) {
    const startSec = convert12HourToSeconds(startTime);
    const endSec = convert12HourToSeconds(endTime);
    return secondsToDuration(endSec - startSec);
}

function getIdleTime(startTime, endTime) {
    const startSec = convert12HourToSeconds(startTime);
    const endSec = convert12HourToSeconds(endTime);
    const DELIVERY_START = 8 * 3600;
    const DELIVERY_END = 22 * 3600;

    let idleSec = 0;

    if (startSec < DELIVERY_START) {
        idleSec += Math.min(endSec, DELIVERY_START) - startSec;
    }

    if (endSec > DELIVERY_END) {
        idleSec += endSec - Math.max(startSec, DELIVERY_END);
    }

    return secondsToDuration(idleSec);
}

function getActiveTime(shiftDuration, idleTime) {
    return secondsToDuration(durationToSeconds(shiftDuration) - durationToSeconds(idleTime));
}

function metQuota(date, activeTime) {
    const quotaSec = isEidPeriod(date)
        ? 6 * 3600
        : 8 * 3600 + 24 * 60;
    return durationToSeconds(activeTime) >= quotaSec;
}

function addShiftRecord(textFile, shiftObj) {
    const { driverID, driverName, date, startTime, endTime } = shiftObj;

    const raw = fs.readFileSync(textFile, 'utf8');
    const lines = raw.split('\n');

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

    const shiftDuration = getShiftDuration(startTime, endTime);
    const idleTime = getIdleTime(startTime, endTime);
    const activeTime = getActiveTime(shiftDuration, idleTime);
    const quota = metQuota(date, activeTime);
    const hasBonus = false;

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
        let lastNonEmpty = lines.length - 1;
        while (lastNonEmpty >= 0 && lines[lastNonEmpty].trim() === '') {
            lastNonEmpty--;
        }
        lines.splice(lastNonEmpty + 1, 0, newLine);
    }

    let content = lines.join('\n').replace(/\n+$/, '') + '\n';
    fs.writeFileSync(textFile, content, 'utf8');

    return {
        driverID: driverID.trim(),
        driverName: driverName.trim(),
        date: date.trim(),
        startTime: startTime.trim(),
        endTime: endTime.trim(),
        shiftDuration,
        idleTime,
        activeTime,
        metQuota: quota,
        hasBonus
    };
}

function setBonus(textFile, driverID, date, newValue) {
    const raw = fs.readFileSync(textFile, 'utf8');
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

function countBonusPerMonth(textFile, driverID, month) {
    const targetMonth = parseInt(month, 10);
    const raw = fs.readFileSync(textFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');

    let driverExists = false;
    let count = 0;

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

function getTotalActiveHoursPerMonth(textFile, driverID, month) {
    const targetMonth = parseInt(month, 10);
    const raw = fs.readFileSync(textFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');

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

function getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month) {
    const rateRaw = fs.readFileSync(rateFile, 'utf8');
    const rateLines = rateRaw.split('\n').filter(l => l.trim() !== '');

    let dayOff = null;
    for (const line of rateLines) {
        const cols = line.split(',');
        if (cols[0].trim() === driverID.trim()) {
            dayOff = cols[1].trim();
            break;
        }
    }

    const targetMonth = parseInt(month, 10);
    const shiftRaw = fs.readFileSync(textFile, 'utf8');
    const shiftLines = shiftRaw.split('\n').filter(l => l.trim() !== '');

    let totalRequiredSec = 0;

    for (const line of shiftLines) {
        const cols = line.split(',');
        if (cols[0].trim() !== driverID.trim()) continue;

        const dateStr = cols[2].trim();
        const recordMonth = parseInt(dateStr.split('-')[1], 10);
        if (recordMonth !== targetMonth) continue;

        if (dayOff && getDayOfWeek(dateStr) === dayOff) continue;

        const quotaSec = isEidPeriod(dateStr)
            ? 6 * 3600
            : 8 * 3600 + 24 * 60;

        totalRequiredSec += quotaSec;
    }

    totalRequiredSec -= bonusCount * 2 * 3600;
    if (totalRequiredSec < 0) totalRequiredSec = 0;

    return secondsToDuration(totalRequiredSec);
}

function getNetPay(driverID, actualHours, requiredHours, rateFile) {
    const TIER_ALLOWANCE = { 1: 50, 2: 20, 3: 10, 4: 3 };

    const raw = fs.readFileSync(rateFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim() !== '');

    let basePay = 0;
    let tier = 1;

    for (const line of lines) {
        const cols = line.split(',');
        if (cols[0].trim() === driverID.trim()) {
            basePay = parseInt(cols[2].trim(), 10);
            tier = parseInt(cols[3].trim(), 10);
            break;
        }
    }

    const actualSec = durationToSeconds(actualHours);
    const requiredSec = durationToSeconds(requiredHours);

    if (actualSec >= requiredSec) {
        return basePay;
    }

    const missingHours = Math.floor((requiredSec - actualSec) / 3600);
    const allowance = TIER_ALLOWANCE[tier] !== undefined ? TIER_ALLOWANCE[tier] : 0;
    const billableHours = Math.max(0, missingHours - allowance);

    if (billableHours === 0) return basePay;

    const deductionRate = Math.floor(basePay / 185);
    const deduction = billableHours * deductionRate;

    return basePay - deduction;
}

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
