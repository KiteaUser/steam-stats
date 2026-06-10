import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

const SHEET_URL = process.env.SHEET_URL;
const DATA_DIR = "data";
const TAGS_DIR = path.join(DATA_DIR, "tags");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RAW_5M_MS = 48 * HOUR;
const HOURLY_PEAK_MS = 30 * DAY;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function toUnixSeconds(dateLike) {
  const ms = new Date(dateLike).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function bucketUnix(timestamp, bucketSeconds) {
  return Math.floor(timestamp / bucketSeconds) * bucketSeconds;
}

function dedupeByTimestamp(points) {
  const map = new Map();

  for (const point of points || []) {
    if (!Array.isArray(point) || point.length < 2) continue;

    const t = Number(point[0]);
    const v = Number(point[1]);

    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;

    map.set(t, v);
  }

  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function mergePeakPoints(existingPoints, incomingPoints) {
  const map = new Map();

  for (const point of [...(existingPoints || []), ...(incomingPoints || [])]) {
    if (!Array.isArray(point) || point.length < 2) continue;

    const t = Number(point[0]);
    const v = Number(point[1]);

    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;

    const existing = map.get(t);
    map.set(t, existing == null ? v : Math.max(existing, v));
  }

  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function normalizePointArray(value) {
  if (!value) return [];

  let points = value;

  if (typeof points === "string") {
    try {
      points = JSON.parse(points);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(points)) return [];

  return points
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([timestamp, players]) => [Number(timestamp), Number(players)])
    .filter(([timestamp, players]) => Number.isFinite(timestamp) && Number.isFinite(players));
}

function getIncomingHourlyPeak(game) {
  return normalizePointArray(
    game.historicHourlyPeak ||
      game.historic_hourly_peak ||
      game.hourlyPeak ||
      game.hourly_peak ||
      game.steamchartsHourlyPeak ||
      game.steamcharts_hourly_peak
  );
}

function getIncomingDailyPeak(game) {
  return normalizePointArray(
    game.historicDailyPeak ||
      game.historic_daily_peak ||
      game.dailyPeak ||
      game.daily_peak ||
      game.steamchartsDailyPeak ||
      game.steamcharts_daily_peak ||
      game.steamdbDailyPeak ||
      game.steamdb_daily_peak
  );
}

function getIncomingMonthlyPeak(game) {
  return normalizePointArray(
    game.historicMonthlyPeak ||
      game.historic_monthly_peak ||
      game.monthlyPeak ||
      game.monthly_peak ||
      game.steamchartsMonthlyPeak ||
      game.steamcharts_monthly_peak ||
      game.steamdbMonthlyPeak ||
      game.steamdb_monthly_peak
  );
}

function upsertPeak(points, timestamp, value) {
  const existing = points.find((point) => point[0] === timestamp);

  if (existing) {
    existing[1] = Math.max(existing[1], value);
  } else {
    points.push([timestamp, value]);
  }
}

function peakFromPoints(points) {
  if (!points.length) return null;

  let best = points[0];

  for (const point of points) {
    if (point[1] > best[1]) {
      best = point;
    }
  }

  return [best[0], best[1]];
}

function getAllChartPoints(chartData) {
  return [
    ...(chartData?.series?.monthlyPeak || []),
    ...(chartData?.series?.dailyPeak || []),
    ...(chartData?.series?.hourlyPeak || []),
    ...(chartData?.series?.raw5m || [])
  ].filter((point) => Array.isArray(point) && point.length >= 2);
}

function getPeakSince(chartData, cutoffTs) {
  return peakFromPoints(
    getAllChartPoints(chartData).filter(([timestamp]) => timestamp >= cutoffTs)
  );
}

function getChartAllTimePeak(chartData) {
  const peak = peakFromPoints(getAllChartPoints(chartData));
  return Array.isArray(peak) ? peak[1] : 0;
}

function initChartData(stored, now, nowTs, players) {
  const peak24hTs = stored?.peak24hAt ? toUnixSeconds(stored.peak24hAt) : null;

  return {
    schemaVersion: 1,
    updatedAt: now,
    updatedAtTs: nowTs,
    source: "steam",
    sourceIntervalSeconds: 300,
    retention: {
      raw5mSeconds: RAW_5M_MS / SECOND,
      hourlyPeakSeconds: HOURLY_PEAK_MS / SECOND,
      dailyPeakAfterSeconds: HOURLY_PEAK_MS / SECOND
    },
    summary: {
      current: [nowTs, players],
      peak24h: peak24hTs && stored?.peak24h ? [peak24hTs, Number(stored.peak24h)] : null,
      peak48h: null,
      allTimePeak: stored?.allTimePeak ? [null, Number(stored.allTimePeak)] : null
    },
    series: {
      raw5m: [],
      hourlyPeak: [],
      dailyPeak: [],
      monthlyPeak: []
    }
  };
}

function updateChartData(stored, game, now, nowMs, players, provisionalAllTimePeak) {
  const nowTs = Math.floor(nowMs / SECOND);
  const chartData = stored?.chartData || initChartData(stored, now, nowTs, players);

  chartData.schemaVersion = chartData.schemaVersion || 1;
  chartData.updatedAt = now;
  chartData.updatedAtTs = nowTs;
  chartData.source = chartData.source || "steam";
  chartData.sourceIntervalSeconds = chartData.sourceIntervalSeconds || 300;

  chartData.retention = {
    raw5mSeconds: RAW_5M_MS / SECOND,
    hourlyPeakSeconds: HOURLY_PEAK_MS / SECOND,
    dailyPeakAfterSeconds: HOURLY_PEAK_MS / SECOND
  };

  chartData.summary ||= {};
  chartData.series ||= {};
  chartData.series.raw5m = dedupeByTimestamp(chartData.series.raw5m || []);
  chartData.series.hourlyPeak = mergePeakPoints(chartData.series.hourlyPeak || []);
  chartData.series.dailyPeak = mergePeakPoints(chartData.series.dailyPeak || []);
  chartData.series.monthlyPeak = mergePeakPoints(chartData.series.monthlyPeak || []);

  const incomingHourlyPeak = getIncomingHourlyPeak(game);
  const incomingDailyPeak = getIncomingDailyPeak(game);
  const incomingMonthlyPeak = getIncomingMonthlyPeak(game);

  chartData.series.hourlyPeak = mergePeakPoints(chartData.series.hourlyPeak, incomingHourlyPeak);
  chartData.series.dailyPeak = mergePeakPoints(chartData.series.dailyPeak, incomingDailyPeak);
  chartData.series.monthlyPeak = mergePeakPoints(chartData.series.monthlyPeak, incomingMonthlyPeak);

  chartData.series.raw5m.push([nowTs, players]);
  chartData.series.raw5m = dedupeByTimestamp(chartData.series.raw5m);

  const rawKeep = [];
  const rawToRollup = [];

  for (const point of chartData.series.raw5m) {
    const ageMs = nowMs - point[0] * SECOND;

    if (ageMs <= RAW_5M_MS) {
      rawKeep.push(point);
    } else {
      rawToRollup.push(point);
    }
  }

  chartData.series.raw5m = rawKeep;

  for (const [timestamp, value] of rawToRollup) {
    upsertPeak(chartData.series.hourlyPeak, bucketUnix(timestamp, 60 * 60), value);
  }

  const hourlyKeep = [];
  const hourlyToRollup = [];

  for (const point of chartData.series.hourlyPeak) {
    const ageMs = nowMs - point[0] * SECOND;

    if (ageMs <= HOURLY_PEAK_MS) {
      hourlyKeep.push(point);
    } else {
      hourlyToRollup.push(point);
    }
  }

  chartData.series.hourlyPeak = hourlyKeep;

  for (const [timestamp, value] of hourlyToRollup) {
    upsertPeak(chartData.series.dailyPeak, bucketUnix(timestamp, 24 * 60 * 60), value);
  }

  chartData.series.raw5m.sort((a, b) => a[0] - b[0]);
  chartData.series.hourlyPeak.sort((a, b) => a[0] - b[0]);
  chartData.series.dailyPeak.sort((a, b) => a[0] - b[0]);
  chartData.series.monthlyPeak.sort((a, b) => a[0] - b[0]);

  const chartAllTimePeak = getChartAllTimePeak(chartData);
  const allTimePeak = Math.max(Number(provisionalAllTimePeak) || 0, chartAllTimePeak, players);

  chartData.summary.current = [nowTs, players];
  chartData.summary.peak24h = getPeakSince(chartData, nowTs - 24 * 60 * 60);
  chartData.summary.peak48h = getPeakSince(chartData, nowTs - 48 * 60 * 60);
  chartData.summary.allTimePeak = [null, allTimePeak];

  return chartData;
}

async function run() {
  if (!SHEET_URL) {
    console.error("Missing SHEET_URL");
    process.exit(1);
  }

  const res = await fetch(SHEET_URL);
  const text = await res.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(text);
    process.exit(1);
  }

  const games = Array.isArray(payload) ? payload : payload.data;

  if (!Array.isArray(games)) {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  await ensureDir(DATA_DIR);
  await ensureDir(TAGS_DIR);

  let previousTop10 = [];
  try {
    const existingTop10 = await fs.readFile(path.join(DATA_DIR, "top10.json"), "utf8");
    previousTop10 = JSON.parse(existingTop10);
  } catch {}

  const previousByTagId = new Map();

  for (const item of previousTop10) {
    if (item && item.tagId != null) {
      previousByTagId.set(String(item.tagId), item);
    }
  }

  for (const game of games) {
    const tagId = String(game.gr_tag_id);
    const filePath = path.join(TAGS_DIR, `${tagId}.json`);

    try {
      const existing = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(existing);

      if (parsed && parsed.tagId != null) {
        previousByTagId.set(String(parsed.tagId), parsed);
      }
    } catch {}
  }

  const steamRequests = games.map((game) => {
    const rawAppid = String(game.steam_appid);
    const steamAppid = rawAppid.replace(/[^\d]/g, "");

    return fetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(
        steamAppid
      )}`
    );
  });

  const steamResponses = await Promise.allSettled(steamRequests);

  const steamPayloads = await Promise.all(
    steamResponses.map(async (result) => {
      if (result.status !== "fulfilled") return {};

      try {
        return await result.value.json();
      } catch {
        return {};
      }
    })
  );

  const now = new Date().toISOString();
  const nowMs = Date.now();
  const results = [];

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const tagId = String(game.gr_tag_id);
    const appid = String(game.steam_appid);
    const steamAppid = Number(appid.replace(/[^\d]/g, "")) || 0;
    const fetchedPlayers = steamPayloads[i]?.response?.player_count;
    const stored = previousByTagId.get(tagId) || {};

    const players = Number.isFinite(Number(fetchedPlayers))
      ? Number(fetchedPlayers)
      : Number(stored.players) || 0;

    const existingPeak = Number(stored?.allTimePeak) || Number(game.all_time_peak) || 0;
    const provisionalAllTimePeak = Math.max(existingPeak, players);

    const chartData = updateChartData(
      stored,
      game,
      now,
      nowMs,
      players,
      provisionalAllTimePeak
    );

    const allTimePeak = Array.isArray(chartData.summary.allTimePeak)
      ? Number(chartData.summary.allTimePeak[1]) || provisionalAllTimePeak
      : provisionalAllTimePeak;

    const peak24hTuple = chartData.summary.peak24h;
    const peak48hTuple = chartData.summary.peak48h;

    const peak24h = Array.isArray(peak24hTuple)
      ? peak24hTuple[1]
      : Number(stored?.peak24h) || players;

    const peak24hAt = Array.isArray(peak24hTuple)
      ? new Date(peak24hTuple[0] * SECOND).toISOString()
      : stored?.peak24hAt || now;

    const record = {
      tagId: Number(tagId),
      appid,
      steamAppid,
      name: game.clean_game_name,
      players,
      allTimePeak,
      peak24h,
      peak24hAt,
      updatedAt: now,
      img_url: game.img_url || "",
      chartData
    };

    if (Array.isArray(peak48hTuple)) {
      record.peak48h = peak48hTuple[1];
      record.peak48hAt = new Date(peak48hTuple[0] * SECOND).toISOString();
    }

    results.push(record);
  }

  const writes = results.map((record) =>
    writeJson(path.join(TAGS_DIR, `${record.tagId}.json`), record)
  );

  await Promise.all(writes);

  const top10 = [...results]
    .sort((a, b) => b.players - a.players)
    .slice(0, 10)
    .map((record) => ({
      ...record,
      appid: record.steamAppid
    }));

  await writeJson(path.join(DATA_DIR, "top10.json"), top10);

  console.log("Done:", results.length);
}

run();
