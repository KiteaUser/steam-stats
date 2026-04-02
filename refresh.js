import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

const SHEET_URL = process.env.SHEET_URL;
const DATA_DIR = "data";
const TAGS_DIR = path.join(DATA_DIR, "tags");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function run() {
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
    const steamAppid = String(game.steam_appid).replace(/[^\d]/g, "");
    return fetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(
        steamAppid
      )}`
    );
  });

  const steamResponses = await Promise.all(steamRequests);
  const steamPayloads = await Promise.all(
    steamResponses.map(async (r) => {
      try {
        return await r.json();
      } catch {
        return {};
      }
    })
  );

  const now = new Date().toISOString();
  const nowMs = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const results = [];

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const tagId = String(game.gr_tag_id);
    const appid = String(game.steam_appid);
    const players = Number(steamPayloads[i]?.response?.player_count) || 0;
    const stored = previousByTagId.get(tagId) || {};

    const existingPeak = Number(stored?.allTimePeak) || Number(game.all_time_peak) || 0;
    const allTimePeak = Math.max(existingPeak, players);

    let peak24h = Number(stored?.peak24h) || players;
    let peak24hAt = stored?.peak24hAt || now;

    if (!stored?.peak24hAt || nowMs - new Date(stored.peak24hAt).getTime() > day) {
      peak24h = players;
      peak24hAt = now;
    } else if (players > peak24h) {
      peak24h = players;
      peak24hAt = now;
    }

    const record = {
      tagId: Number(tagId),
      appid: appid,
      name: game.clean_game_name,
      players,
      allTimePeak,
      peak24h,
      peak24hAt,
      updatedAt: now,
      img_url: game.img_url || ""
    };

    results.push(record);
  }

  const writes = results.map((record) =>
    writeJson(path.join(TAGS_DIR, `${record.tagId}.json`), record)
  );
  await Promise.all(writes);

  const top10 = [...results].sort((a, b) => b.players - a.players).slice(0, 10);
  await writeJson(path.join(DATA_DIR, "top10.json"), top10);

  console.log("Done:", results.length);
}

run();
