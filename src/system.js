'use strict';
const os = require('os');
const fs = require('fs');

let lastCpu = null;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuUsage() {
  const now = cpuTimes();
  const prev = lastCpu;
  lastCpu = now;
  if (!prev) return 0;
  const dt = now.total - prev.total;
  return dt > 0 ? Math.max(0, Math.min(1, 1 - (now.idle - prev.idle) / dt)) : 0;
}

function disks() {
  const out = [];
  for (const letter of ['C', 'D', 'E']) {
    try {
      const s = fs.statfsSync(letter + ':\\');
      const total = s.blocks * s.bsize;
      if (total > 0) out.push({ name: letter + ':', total, free: s.bavail * s.bsize });
    } catch { /* no such drive */ }
  }
  return out;
}

function stats() {
  const cpus = os.cpus();
  return {
    cpu: cpuUsage(),
    cpuModel: (cpus[0]?.model || '').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    host: os.hostname(),
    user: os.userInfo().username,
    platform: `Windows ${os.release()}`,
    disks: disks(),
  };
}

const WMO = {
  0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
  45: 'туман', 48: 'изморозь', 51: 'слабая морось', 53: 'морось', 55: 'сильная морось',
  56: 'ледяная морось', 57: 'ледяная морось', 61: 'небольшой дождь', 63: 'дождь', 65: 'ливень',
  66: 'ледяной дождь', 67: 'ледяной дождь', 71: 'небольшой снег', 73: 'снег', 75: 'сильный снег',
  77: 'снежные зёрна', 80: 'ливневый дождь', 81: 'ливни', 82: 'сильные ливни',
  85: 'снегопад', 86: 'сильный снегопад', 95: 'гроза', 96: 'гроза с градом', 99: 'гроза с градом',
};

let weatherCache = { key: '', at: 0, data: null };

async function weather(city) {
  const key = `${city.lat},${city.lon}`;
  if (weatherCache.key === key && Date.now() - weatherCache.at < 10 * 60 * 1000) return weatherCache.data;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day'
    + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto&wind_speed_unit=ms';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('weather ' + res.status);
  const j = await res.json();
  const c = j.current || {};
  const data = {
    city: city.name,
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    wind: c.wind_speed_10m,
    code: c.weather_code,
    isDay: !!c.is_day,
    text: WMO[c.weather_code] || '—',
    max: j.daily?.temperature_2m_max?.[0],
    min: j.daily?.temperature_2m_min?.[0],
  };
  weatherCache = { key, at: Date.now(), data };
  return data;
}

module.exports = { stats, weather };
